import {
  assertRepairSafeProjectionRuntime,
  ProjectionRuntimeSafetyError,
  type ProjectionRuntime,
  type StoredOrderEvent,
} from "@projection-witness/database";
import {
  canonicalSha256,
  fingerprintCandidateProjection,
  fingerprintCurrentProjectionRow,
  RepairEnvelopeSchema,
  runReducerArtifactEvidence,
  snapshotEventStream,
  verifyRepairEnvelope,
  type CurrentProjectionRow,
  type RepairEnvelope,
  type RuntimeEvidence,
} from "@projection-witness/evidence";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { RepairError } from "./errors.js";

const PositiveIntegerSchema = z.number().int().positive().safe();
const OptionalCorrelationSchema = z.string().trim().min(1).max(256).optional();
const MaximumSafeCents = BigInt(Number.MAX_SAFE_INTEGER);
const SafeCentsStringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(16)
  .refine((value) => BigInt(value) <= MaximumSafeCents, {
    message: "Cents must fit the JavaScript safe integer range",
  });
const CanonicalTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value, {
    message: "Timestamp must use canonical millisecond UTC form",
  });

export const ApplyProjectionRepairInputSchema = z
  .object({
    planId: z.uuid(),
    projectionName: z.string().trim().min(1).max(128),
    streamId: z.string().trim().min(1).max(128),
    streamSha256: z.string().regex(/^[0-9a-f]{64}$/),
    currentRowVersion: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .max(19),
    currentRowSha256: z.string().regex(/^[0-9a-f]{64}$/),
    reducerSha256: z.string().regex(/^[0-9a-f]{64}$/),
    runtimeGeneration: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .max(19),
    evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: CanonicalTimestampSchema,
    trueforgeSessionId: OptionalCorrelationSchema,
    trueforgeTurnId: OptionalCorrelationSchema,
    trueforgeToolCallId: OptionalCorrelationSchema,
  })
  .strict();

export type ApplyProjectionRepairInput = z.infer<typeof ApplyProjectionRepairInputSchema>;

export interface ProjectionRepairOptions {
  reducerArtifactPath: string;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  maxEvents?: number;
  maxCanonicalBytes?: number;
  maxReducerExecutionMs?: number;
  generateAuditId?: () => string;
  afterLocks?: () => Promise<void>;
  beforeAuditInsert?: () => Promise<void>;
}

export interface StagedRepairPlan {
  planId: string;
  evidenceSha256: string;
  status: "PREPARED" | "APPLIED";
  created: boolean;
}

export interface AppliedRepairReceipt {
  status: "APPLIED" | "ALREADY_APPLIED";
  planId: string;
  auditId: string;
  receiptSha256: string;
}

interface PlanRow {
  plan_id: string;
  schema_version: number;
  projection_name: string;
  stream_id: string;
  stream_head_version: number;
  event_count: number;
  stream_sha256: string;
  runtime_generation: string;
  reducer_sha256: string;
  source_commit_sha: string;
  current_row_version: string;
  current_row_sha256: string;
  current_row: unknown;
  candidate_row_sha256: string;
  candidate_row: unknown;
  evidence_sha256: string;
  status: "PREPARED" | "APPLIED";
  created_at: Date;
  expires_at: Date;
  applied_at: Date | null;
}

interface RuntimeRow {
  generation: string;
  reducer_sha256: string;
  source_commit_sha: string;
  algorithm_version: string;
  gap_strategy: string;
}

interface StreamHeadRow {
  version: number;
}

interface EventRow {
  event_id: string;
  global_position: string;
  stream_id: string;
  stream_version: number;
  event_type: StoredOrderEvent["eventType"];
  payload: unknown;
  metadata: unknown;
  recorded_at: Date;
}

interface OrderViewRow {
  order_id: string;
  total_cents: string;
  paid_cents: string;
  payment_status: string;
  fulfillment_status: string;
  last_stream_version: number;
  row_version: string;
}

interface AuditRow {
  audit_id: string;
  after_row: unknown;
  after_row_sha256: string;
  receipt_sha256: string;
}

interface BoundedStreamMetricsRow {
  event_count: string;
  raw_bytes: string;
}

interface ResolvedProjectionRepairOptions {
  reducerArtifactPath: string;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  maxEvents: number;
  maxCanonicalBytes: number;
  maxReducerExecutionMs: number;
  generateAuditId: () => string;
  afterLocks: (() => Promise<void>) | undefined;
  beforeAuditInsert: (() => Promise<void>) | undefined;
}

function storedEvent(row: EventRow): StoredOrderEvent {
  return {
    eventId: row.event_id,
    globalPosition: row.global_position,
    streamId: row.stream_id,
    streamVersion: row.stream_version,
    eventType: row.event_type,
    payload: row.payload as StoredOrderEvent["payload"],
    metadata: row.metadata as StoredOrderEvent["metadata"],
    recordedAt: row.recorded_at.toISOString(),
  };
}

function canonicalCurrentRow(row: OrderViewRow): CurrentProjectionRow {
  return {
    orderId: row.order_id,
    totalCents: row.total_cents,
    paidCents: row.paid_cents,
    paymentStatus: row.payment_status as CurrentProjectionRow["paymentStatus"],
    fulfillmentStatus: row.fulfillment_status as CurrentProjectionRow["fulfillmentStatus"],
    lastStreamVersion: row.last_stream_version,
    rowVersion: row.row_version,
  };
}

function runtimeEvidence(projectionName: string, row: RuntimeRow): RuntimeEvidence {
  return {
    projectionName,
    generation: row.generation,
    reducerSha256: row.reducer_sha256,
    sourceCommitSha: row.source_commit_sha,
    algorithmVersion: row.algorithm_version,
    gapStrategy: row.gap_strategy,
  };
}

function runtimeForSafety(projectionName: string, row: RuntimeRow): ProjectionRuntime {
  return {
    ...runtimeEvidence(projectionName, row),
    registeredAt: new Date(0),
  };
}

function envelopeFromPlan(plan: PlanRow): RepairEnvelope {
  return RepairEnvelopeSchema.parse({
    schemaVersion: plan.schema_version,
    planId: plan.plan_id,
    projectionName: plan.projection_name,
    stream: {
      streamId: plan.stream_id,
      headVersion: plan.stream_head_version,
      eventCount: plan.event_count,
      sha256: plan.stream_sha256,
    },
    runtime: {
      projectionName: plan.projection_name,
      generation: plan.runtime_generation,
      reducerSha256: plan.reducer_sha256,
      sourceCommitSha: plan.source_commit_sha,
      algorithmVersion: "gap-aware-v1",
      gapStrategy: "TRACKED_NON_BLOCKING",
    },
    currentRow: {
      rowVersion: plan.current_row_version,
      sha256: plan.current_row_sha256,
      value: plan.current_row,
    },
    candidateRow: {
      sha256: plan.candidate_row_sha256,
      value: plan.candidate_row,
    },
    invariants: [
      { id: "stream_versions_contiguous", passed: true },
      { id: "reducer_deterministic", passed: true },
      { id: "candidate_matches_stream_head", passed: true },
      { id: "root_projector_fix_active", passed: true },
    ],
    createdAt: plan.created_at.toISOString(),
    expiresAt: plan.expires_at.toISOString(),
    evidenceSha256: plan.evidence_sha256,
  });
}

function assertSafeEnvelopeValues(envelope: RepairEnvelope): void {
  CanonicalTimestampSchema.parse(envelope.createdAt);
  CanonicalTimestampSchema.parse(envelope.expiresAt);
  for (const value of [
    envelope.currentRow.value.totalCents,
    envelope.currentRow.value.paidCents,
    envelope.candidateRow.value.totalCents,
    envelope.candidateRow.value.paidCents,
  ]) {
    SafeCentsStringSchema.parse(value);
  }
}

async function loadBoundedStream(
  client: PoolClient,
  streamId: string,
  headVersion: number,
  maxEvents: number,
  maxCanonicalBytes: number,
) {
  if (headVersion > maxEvents) {
    throw new RepairError("PLAN_INVALID", "Event stream exceeds the configured count limit");
  }
  const boundedLimit = maxEvents + 1;
  const metricsResult = await client.query<BoundedStreamMetricsRow>(
    `WITH bounded AS (
       SELECT
         event_id, global_position, stream_id, stream_version,
         event_type, payload, metadata, recorded_at
       FROM events
       WHERE stream_id = $1
       ORDER BY stream_version
       LIMIT $2
     )
     SELECT
       count(*)::text AS event_count,
       COALESCE(sum(
         octet_length(event_id::text)
         + octet_length(global_position::text)
         + octet_length(stream_id)
         + octet_length(stream_version::text)
         + octet_length(event_type)
         + octet_length(payload::text)
         + octet_length(metadata::text)
         + octet_length(recorded_at::text)
       ), 0)::text AS raw_bytes
     FROM bounded`,
    [streamId, boundedLimit],
  );
  const metrics = metricsResult.rows[0];
  if (metrics === undefined) {
    throw new RepairError("APPLY_FAILED", "Bounded stream metrics returned no row");
  }
  const eventCount = Number(metrics.event_count);
  if (!Number.isSafeInteger(eventCount) || eventCount > maxEvents) {
    throw new RepairError("PLAN_INVALID", "Event stream exceeds the configured count limit");
  }
  if (BigInt(metrics.raw_bytes) > BigInt(maxCanonicalBytes)) {
    throw new RepairError("PLAN_INVALID", "Event stream exceeds the configured byte limit");
  }

  const eventsResult = await client.query<EventRow>(
    `SELECT
       event_id, global_position::text, stream_id, stream_version,
       event_type, payload, metadata, recorded_at
     FROM events
     WHERE stream_id = $1
     ORDER BY stream_version
     LIMIT $2`,
    [streamId, boundedLimit],
  );
  return snapshotEventStream({
    streamId,
    headVersion,
    events: eventsResult.rows.map(storedEvent),
    maxEvents,
    maxCanonicalBytes,
  });
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original repair refusal remains authoritative.
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export class ProjectionRepairService {
  private readonly pool: Pool;
  private readonly options: ResolvedProjectionRepairOptions;

  constructor(pool: Pool, options: ProjectionRepairOptions) {
    this.pool = pool;
    this.options = {
      reducerArtifactPath: z.string().trim().min(1).max(512).parse(options.reducerArtifactPath),
      lockTimeoutMs: PositiveIntegerSchema.parse(options.lockTimeoutMs ?? 2_000),
      statementTimeoutMs: PositiveIntegerSchema.parse(options.statementTimeoutMs ?? 5_000),
      maxEvents: PositiveIntegerSchema.parse(options.maxEvents ?? 1_000),
      maxCanonicalBytes: PositiveIntegerSchema.parse(options.maxCanonicalBytes ?? 1_048_576),
      maxReducerExecutionMs: PositiveIntegerSchema.parse(options.maxReducerExecutionMs ?? 2_000),
      generateAuditId: options.generateAuditId ?? randomUUID,
      afterLocks: options.afterLocks,
      beforeAuditInsert: options.beforeAuditInsert,
    };
  }

  async stageRepairPlan(input: unknown): Promise<StagedRepairPlan> {
    let envelope: RepairEnvelope;
    try {
      envelope = verifyRepairEnvelope(input);
      assertSafeEnvelopeValues(envelope);
    } catch {
      throw new RepairError("PLAN_INVALID", "Repair envelope is invalid");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${String(this.options.statementTimeoutMs)}ms`,
      ]);

      const runtimeResult = await client.query<RuntimeRow>(
        `SELECT generation::text, reducer_sha256, source_commit_sha, algorithm_version, gap_strategy
         FROM projection_runtime
         WHERE projection_name = $1`,
        [envelope.projectionName],
      );
      const runtime = runtimeResult.rows[0];
      if (runtime === undefined) {
        throw new RepairError("RUNTIME_UNATTESTED", "Projection runtime is not registered");
      }
      try {
        assertRepairSafeProjectionRuntime(runtimeForSafety(envelope.projectionName, runtime));
      } catch (error) {
        if (error instanceof ProjectionRuntimeSafetyError) {
          throw new RepairError(error.code, error.message);
        }
        throw error;
      }
      const liveRuntime = runtimeEvidence(envelope.projectionName, runtime);
      if (
        liveRuntime.generation !== envelope.runtime.generation ||
        liveRuntime.reducerSha256 !== envelope.runtime.reducerSha256 ||
        liveRuntime.sourceCommitSha !== envelope.runtime.sourceCommitSha ||
        liveRuntime.algorithmVersion !== envelope.runtime.algorithmVersion ||
        liveRuntime.gapStrategy !== envelope.runtime.gapStrategy
      ) {
        throw new RepairError("PLAN_INVALID", "Runtime evidence does not match live state");
      }

      const headResult = await client.query<StreamHeadRow>(
        "SELECT version FROM event_streams WHERE stream_id = $1",
        [envelope.stream.streamId],
      );
      const streamHead = headResult.rows[0];
      if (streamHead === undefined) {
        throw new RepairError("PLAN_INVALID", "Event stream was not found");
      }
      const rowResult = await client.query<OrderViewRow>(
        `SELECT
           order_id, total_cents::text, paid_cents::text, payment_status,
           fulfillment_status, last_stream_version, row_version::text
         FROM order_view
         WHERE order_id = $1`,
        [envelope.stream.streamId],
      );
      const currentRow = rowResult.rows[0];
      if (currentRow === undefined) {
        throw new RepairError("PLAN_INVALID", "Projection row was not found");
      }
      const stream = await loadBoundedStream(
        client,
        envelope.stream.streamId,
        streamHead.version,
        this.options.maxEvents,
        this.options.maxCanonicalBytes,
      );
      const currentFingerprint = fingerprintCurrentProjectionRow(canonicalCurrentRow(currentRow));
      const reducerEvidence = await runReducerArtifactEvidence(
        this.options.reducerArtifactPath,
        {
          schemaVersion: 1,
          expectedReducerSha256: runtime.reducer_sha256,
          streamId: envelope.stream.streamId,
          headVersion: streamHead.version,
          events: stream.events,
        },
        {
          maxEvents: this.options.maxEvents,
          maxCanonicalBytes: this.options.maxCanonicalBytes,
          maxExecutionMs: this.options.maxReducerExecutionMs,
        },
      );
      const candidateFingerprint = fingerprintCandidateProjection(reducerEvidence.candidate.value);
      if (
        envelope.stream.headVersion !== streamHead.version ||
        envelope.stream.eventCount !== stream.evidence.eventCount ||
        envelope.stream.sha256 !== stream.evidence.sha256 ||
        envelope.currentRow.sha256 !== currentFingerprint.sha256 ||
        envelope.candidateRow.sha256 !== candidateFingerprint.sha256
      ) {
        throw new RepairError("PLAN_INVALID", "Envelope evidence does not match live state");
      }

      const result = await client.query<{ plan_id: string; status: "PREPARED" | "APPLIED" }>(
        `INSERT INTO projection_repair_plans (
           plan_id, schema_version, projection_name, stream_id, stream_head_version,
           event_count, stream_sha256, runtime_generation, reducer_sha256,
           source_commit_sha, current_row_version, current_row_sha256, current_row,
           candidate_row_sha256, candidate_row, evidence_sha256, status, created_at, expires_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::bigint, $9, $10, $11::bigint, $12,
           $13::jsonb, $14, $15::jsonb, $16, 'PREPARED', $17::timestamptz, $18::timestamptz
         )
         ON CONFLICT (evidence_sha256) DO NOTHING
         RETURNING plan_id, status`,
        [
          envelope.planId,
          envelope.schemaVersion,
          envelope.projectionName,
          envelope.stream.streamId,
          envelope.stream.headVersion,
          envelope.stream.eventCount,
          envelope.stream.sha256,
          envelope.runtime.generation,
          envelope.runtime.reducerSha256,
          envelope.runtime.sourceCommitSha,
          envelope.currentRow.rowVersion,
          envelope.currentRow.sha256,
          JSON.stringify(envelope.currentRow.value),
          envelope.candidateRow.sha256,
          JSON.stringify(envelope.candidateRow.value),
          envelope.evidenceSha256,
          envelope.createdAt,
          envelope.expiresAt,
        ],
      );
      const inserted = result.rows[0];
      if (inserted !== undefined) {
        await client.query("COMMIT");
        return {
          planId: inserted.plan_id,
          evidenceSha256: envelope.evidenceSha256,
          status: inserted.status,
          created: true,
        };
      }

      const existing = await client.query<{
        plan_id: string;
        status: "PREPARED" | "APPLIED";
      }>(
        `SELECT plan_id, status
         FROM projection_repair_plans
         WHERE evidence_sha256 = $1`,
        [envelope.evidenceSha256],
      );
      const row = existing.rows[0];
      if (row === undefined || row.plan_id !== envelope.planId) {
        throw new RepairError("PLAN_INVALID", "Idempotent plan lookup did not match the envelope");
      }
      await client.query("COMMIT");
      return {
        planId: row.plan_id,
        evidenceSha256: envelope.evidenceSha256,
        status: row.status,
        created: false,
      };
    } catch (error) {
      await rollback(client);
      if (error instanceof RepairError) {
        throw error;
      }
      throw new RepairError("APPLY_FAILED", "Repair plan staging rolled back");
    } finally {
      client.release();
    }
  }

  async applyRepairPlan(input: ApplyProjectionRepairInput): Promise<AppliedRepairReceipt> {
    const approvalResult = ApplyProjectionRepairInputSchema.safeParse(input);
    if (!approvalResult.success) {
      throw new RepairError("PLAN_INVALID", "Repair approval input is invalid");
    }
    const approval = approvalResult.data;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('lock_timeout', $1, true)", [
        `${String(this.options.lockTimeoutMs)}ms`,
      ]);
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${String(this.options.statementTimeoutMs)}ms`,
      ]);

      const planResult = await client.query<PlanRow>(
        `SELECT
           plan_id, schema_version, projection_name, stream_id, stream_head_version,
           event_count, stream_sha256, runtime_generation::text, reducer_sha256,
           source_commit_sha, current_row_version::text, current_row_sha256,
           current_row, candidate_row_sha256, candidate_row, evidence_sha256,
           status, created_at, expires_at, applied_at
         FROM projection_repair_plans
         WHERE plan_id = $1
         FOR UPDATE`,
        [approval.planId],
      );
      const plan = planResult.rows[0];
      if (plan === undefined) {
        throw new RepairError("PLAN_INVALID", "Repair plan was not found");
      }
      this.assertApprovalMatchesPlan(approval, plan);
      const envelope = verifyRepairEnvelope(envelopeFromPlan(plan));

      const auditResult = await client.query<AuditRow>(
        `SELECT audit_id, after_row, after_row_sha256, receipt_sha256
         FROM projection_repair_audit
         WHERE plan_id = $1`,
        [plan.plan_id],
      );
      const existingAudit = auditResult.rows[0];
      if (existingAudit !== undefined) {
        const currentResult = await client.query<OrderViewRow>(
          `SELECT
             order_id, total_cents::text, paid_cents::text, payment_status,
             fulfillment_status, last_stream_version, row_version::text
           FROM order_view
           WHERE order_id = $1`,
          [plan.stream_id],
        );
        const currentRow = currentResult.rows[0];
        if (currentRow === undefined) {
          throw new RepairError("VERIFICATION_FAILED", "Applied projection row is missing");
        }
        const { rowVersion: _rowVersion, ...currentBusinessValue } =
          canonicalCurrentRow(currentRow);
        const currentBusiness = fingerprintCandidateProjection(currentBusinessValue);
        if (
          currentBusiness.sha256 !== existingAudit.after_row_sha256 ||
          canonicalSha256(existingAudit.after_row) !== existingAudit.after_row_sha256
        ) {
          throw new RepairError(
            "VERIFICATION_FAILED",
            "Applied repair audit no longer matches the projection row",
          );
        }
        await client.query("ROLLBACK");
        return {
          status: "ALREADY_APPLIED",
          planId: plan.plan_id,
          auditId: existingAudit.audit_id,
          receiptSha256: existingAudit.receipt_sha256,
        };
      }

      const runtimeResult = await client.query<RuntimeRow>(
        `SELECT generation::text, reducer_sha256, source_commit_sha, algorithm_version, gap_strategy
         FROM projection_runtime
         WHERE projection_name = $1
         FOR UPDATE`,
        [plan.projection_name],
      );
      const runtime = runtimeResult.rows[0];
      if (runtime === undefined) {
        throw new RepairError("RUNTIME_UNATTESTED", "Projection runtime is not registered");
      }

      const streamHeadResult = await client.query<StreamHeadRow>(
        `SELECT version
         FROM event_streams
         WHERE stream_id = $1
         FOR UPDATE`,
        [plan.stream_id],
      );
      const streamHead = streamHeadResult.rows[0];
      if (streamHead === undefined) {
        throw new RepairError("STALE_PLAN", "Event stream no longer exists", ["stream"]);
      }

      const rowResult = await client.query<OrderViewRow>(
        "SELECT * FROM lock_order_view_for_repair($1)",
        [plan.stream_id],
      );
      const currentRow = rowResult.rows[0];
      if (currentRow === undefined) {
        throw new RepairError("STALE_PLAN", "Projection row no longer exists", ["row"]);
      }
      await this.options.afterLocks?.();

      if (plan.status !== "PREPARED") {
        throw new RepairError("PLAN_INVALID", "Repair plan is not prepared");
      }
      const databaseTime = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = databaseTime.rows[0]?.now;
      if (now === undefined) {
        throw new RepairError("APPLY_FAILED", "Database clock did not return a value");
      }
      if (now.getTime() >= plan.expires_at.getTime()) {
        throw new RepairError("PLAN_EXPIRED", "Repair plan has expired");
      }

      try {
        assertRepairSafeProjectionRuntime(runtimeForSafety(plan.projection_name, runtime));
      } catch (error) {
        if (error instanceof ProjectionRuntimeSafetyError) {
          throw new RepairError(error.code, error.message);
        }
        throw error;
      }

      const streamSnapshot = await loadBoundedStream(
        client,
        plan.stream_id,
        streamHead.version,
        this.options.maxEvents,
        this.options.maxCanonicalBytes,
      );
      const currentFingerprint = fingerprintCurrentProjectionRow(canonicalCurrentRow(currentRow));
      const earlyMismatches = this.findMismatches(
        plan,
        runtime,
        streamHead,
        streamSnapshot.evidence.sha256,
        streamSnapshot.evidence.eventCount,
        currentFingerprint.sha256,
        plan.candidate_row_sha256,
      ).filter((category) => category !== "candidate");
      if (earlyMismatches.length > 0) {
        throw new RepairError(
          "STALE_PLAN",
          "Live evidence no longer matches the plan",
          earlyMismatches,
        );
      }
      const reducerEvidence = await runReducerArtifactEvidence(
        this.options.reducerArtifactPath,
        {
          schemaVersion: 1,
          expectedReducerSha256: runtime.reducer_sha256,
          streamId: plan.stream_id,
          headVersion: streamHead.version,
          events: streamSnapshot.events,
        },
        {
          maxEvents: this.options.maxEvents,
          maxCanonicalBytes: this.options.maxCanonicalBytes,
          maxExecutionMs: this.options.maxReducerExecutionMs,
        },
      );
      const candidateFingerprint = fingerprintCandidateProjection(reducerEvidence.candidate.value);

      const mismatches = this.findMismatches(
        plan,
        runtime,
        streamHead,
        streamSnapshot.evidence.sha256,
        streamSnapshot.evidence.eventCount,
        currentFingerprint.sha256,
        candidateFingerprint.sha256,
      );
      if (mismatches.length > 0) {
        throw new RepairError("STALE_PLAN", "Live evidence no longer matches the plan", mismatches);
      }

      const { rowVersion: _rowVersion, ...currentBusinessValue } = currentFingerprint.value;
      if (canonicalSha256(currentBusinessValue) === canonicalSha256(candidateFingerprint.value)) {
        await client.query("ROLLBACK");
        throw new RepairError("NOOP_ALREADY_CORRECT", "Projection row already matches candidate");
      }

      const candidate = candidateFingerprint.value;
      await this.options.beforeAuditInsert?.();
      const auditId = z.uuid().parse(this.options.generateAuditId());
      const appliedTime = await client.query<{ applied_at: Date }>(
        "SELECT clock_timestamp() AS applied_at",
      );
      const appliedAt = appliedTime.rows[0]?.applied_at.toISOString();
      if (appliedAt === undefined) {
        throw new RepairError("APPLY_FAILED", "Database apply clock did not return a value");
      }
      const receiptSha256 = canonicalSha256({
        auditId,
        planId: plan.plan_id,
        projectionName: plan.projection_name,
        streamId: plan.stream_id,
        beforeRowSha256: plan.current_row_sha256,
        afterRowSha256: plan.candidate_row_sha256,
        streamSha256: plan.stream_sha256,
        reducerSha256: plan.reducer_sha256,
        runtimeGeneration: plan.runtime_generation,
        correlationTrust: "SUPPLIED",
        trueforgeSessionId: approval.trueforgeSessionId ?? null,
        trueforgeTurnId: approval.trueforgeTurnId ?? null,
        trueforgeToolCallId: approval.trueforgeToolCallId ?? null,
        appliedAt,
      });
      await client.query(
        `INSERT INTO projection_repair_audit (
           audit_id, plan_id, projection_name, stream_id, before_row,
           before_row_sha256, after_row, after_row_sha256, stream_sha256,
           reducer_sha256, runtime_generation, trueforge_session_id,
           trueforge_turn_id, trueforge_tool_call_id, correlation_trust,
           applied_at, receipt_sha256
         )
         VALUES (
           $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11::bigint,
           $12, $13, $14, 'SUPPLIED', $15::timestamptz, $16
         )`,
        [
          auditId,
          plan.plan_id,
          plan.projection_name,
          plan.stream_id,
          JSON.stringify(envelope.currentRow.value),
          plan.current_row_sha256,
          JSON.stringify(candidate),
          plan.candidate_row_sha256,
          plan.stream_sha256,
          plan.reducer_sha256,
          plan.runtime_generation,
          approval.trueforgeSessionId ?? null,
          approval.trueforgeTurnId ?? null,
          approval.trueforgeToolCallId ?? null,
          appliedAt,
          receiptSha256,
        ],
      );
      const updateResult = await client.query<{ affected_rows: string }>(
        `SELECT apply_order_view_repair($1::uuid, $2::bigint)::text AS affected_rows`,
        [plan.plan_id, plan.current_row_version],
      );
      if (updateResult.rows[0]?.affected_rows !== "1") {
        throw new RepairError("STALE_PLAN", "Projection compare-and-swap failed", ["row"]);
      }
      const completion = await client.query(
        `UPDATE projection_repair_plans
         SET status = 'APPLIED', applied_at = $2::timestamptz
         WHERE plan_id = $1 AND status = 'PREPARED'`,
        [plan.plan_id, appliedAt],
      );
      if (completion.rowCount !== 1) {
        throw new RepairError("APPLY_FAILED", "Plan completion affected an unexpected row count");
      }

      await client.query("COMMIT");
      return {
        status: "APPLIED",
        planId: plan.plan_id,
        auditId,
        receiptSha256,
      };
    } catch (error) {
      await rollback(client);
      if (error instanceof RepairError) {
        throw error;
      }
      if (databaseErrorCode(error) === "55P03") {
        throw new RepairError("LOCK_TIMEOUT", "Repair locks could not be acquired in time");
      }
      throw new RepairError("APPLY_FAILED", "Repair transaction rolled back");
    } finally {
      client.release();
    }
  }

  private assertApprovalMatchesPlan(approval: ApplyProjectionRepairInput, plan: PlanRow): void {
    const matches =
      approval.projectionName === plan.projection_name &&
      approval.streamId === plan.stream_id &&
      approval.streamSha256 === plan.stream_sha256 &&
      approval.currentRowVersion === plan.current_row_version &&
      approval.currentRowSha256 === plan.current_row_sha256 &&
      approval.reducerSha256 === plan.reducer_sha256 &&
      approval.runtimeGeneration === plan.runtime_generation &&
      approval.evidenceSha256 === plan.evidence_sha256 &&
      approval.expiresAt === plan.expires_at.toISOString();
    if (!matches) {
      throw new RepairError("PLAN_INVALID", "Approval input does not match the persisted plan");
    }
  }

  private findMismatches(
    plan: PlanRow,
    runtime: RuntimeRow,
    streamHead: StreamHeadRow,
    streamSha256: string,
    eventCount: number,
    currentRowSha256: string,
    candidateRowSha256: string,
  ): string[] {
    const mismatches: string[] = [];
    if (
      runtime.generation !== plan.runtime_generation ||
      runtime.reducer_sha256 !== plan.reducer_sha256 ||
      runtime.source_commit_sha !== plan.source_commit_sha
    ) {
      mismatches.push("runtime");
    }
    if (
      streamHead.version !== plan.stream_head_version ||
      eventCount !== plan.event_count ||
      streamSha256 !== plan.stream_sha256
    ) {
      mismatches.push("stream");
    }
    if (currentRowSha256 !== plan.current_row_sha256) {
      mismatches.push("row");
    }
    if (candidateRowSha256 !== plan.candidate_row_sha256) {
      mismatches.push("candidate");
    }
    return mismatches;
  }
}
