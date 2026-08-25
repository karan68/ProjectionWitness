import { OrderEventStore, getProjectionRuntime } from "@projection-witness/database";
import { fingerprintCandidateProjection, snapshotEventStream } from "@projection-witness/evidence";
import {
  type ProjectionRepairService,
  RepairError,
  type ApplyProjectionRepairInput,
} from "@projection-witness/repair";
import type { Pool } from "pg";
import { z } from "zod";
import {
  ApplyRepairInputSchema,
  ApplyOutputSchema,
  FindCaseOutputSchema,
  InspectCaseOutputSchema,
  OrderCaseInputSchema,
  ProjectionCaseInputSchema,
  PublicStateOutputSchema,
  RuntimeInputSchema,
  RuntimeOutputSchema,
  SnapshotOutputSchema,
  SnapshotStreamInputSchema,
  StageOutputSchema,
  StageRepairInputSchema,
  ToolErrorSchema,
  VerifyOutputSchema,
  VerifyRepairInputSchema,
} from "./schemas.js";

interface ProjectionRow {
  order_id: string;
  total_cents: string;
  paid_cents: string;
  payment_status: string;
  fulfillment_status: string;
  last_stream_version: number;
  row_version: string;
}

const MaxPublicApiResponseBytes = 1_048_576;

async function readResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || BigInt(contentLength) > BigInt(MaxPublicApiResponseBytes)) {
      throw new ToolFailure("VERIFICATION_FAILED", "Public API response exceeds the byte limit");
    }
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > MaxPublicApiResponseBytes) {
        await reader.cancel();
        throw new ToolFailure("VERIFICATION_FAILED", "Public API response exceeds the byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, receivedBytes).toString("utf8");
}

export interface ProjectionWitnessToolsOptions {
  readPool: Pool;
  repairService: ProjectionRepairService;
  apiBaseUrl: string;
  apiTimeoutMs?: number;
}

export class ToolFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
  }
}

function canonicalRow(row: ProjectionRow) {
  return {
    orderId: row.order_id,
    totalCents: row.total_cents,
    paidCents: row.paid_cents,
    paymentStatus: row.payment_status,
    fulfillmentStatus: row.fulfillment_status,
    lastStreamVersion: row.last_stream_version,
    rowVersion: row.row_version,
  };
}

export function redactedToolError(error: unknown) {
  if (error instanceof ToolFailure || error instanceof RepairError) {
    return ToolErrorSchema.parse({ code: error.code, message: error.message });
  }
  if (error instanceof z.ZodError) {
    return ToolErrorSchema.parse({ code: "PLAN_INVALID", message: "Tool input is invalid" });
  }
  return ToolErrorSchema.parse({ code: "APPLY_FAILED", message: "Tool operation failed" });
}

export class ProjectionWitnessTools {
  private readonly readPool: Pool;
  private readonly repairService: ProjectionRepairService;
  private readonly apiBaseUrl: URL;
  private readonly apiTimeoutMs: number;

  constructor(options: ProjectionWitnessToolsOptions) {
    this.readPool = options.readPool;
    this.repairService = options.repairService;
    this.apiBaseUrl = new URL(options.apiBaseUrl);
    if (!["http:", "https:"].includes(this.apiBaseUrl.protocol)) {
      throw new Error("API base URL must use HTTP or HTTPS");
    }
    this.apiTimeoutMs = z
      .number()
      .int()
      .positive()
      .safe()
      .parse(options.apiTimeoutMs ?? 3_000);
  }

  async findProjectionCase(input: unknown) {
    const { orderId } = OrderCaseInputSchema.parse(input);
    const result = await this.readPool.query<{
      stream_exists: boolean;
      projection_exists: boolean;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM event_streams WHERE stream_id = $1) AS stream_exists,
         EXISTS (SELECT 1 FROM order_view WHERE order_id = $1) AS projection_exists`,
      [orderId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ToolFailure("DATABASE_UNAVAILABLE", "Case lookup returned no result");
    }
    return FindCaseOutputSchema.parse({
      found: row.stream_exists || row.projection_exists,
      streamExists: row.stream_exists,
      projectionExists: row.projection_exists,
    });
  }

  async getPublicOrderState(input: unknown) {
    const { orderId } = OrderCaseInputSchema.parse(input);
    const url = new URL(`/orders/${encodeURIComponent(orderId)}`, this.apiBaseUrl);
    const response = await fetch(url, { signal: AbortSignal.timeout(this.apiTimeoutMs) });
    const responseText = await readResponseText(response);
    let body: unknown;
    try {
      body = JSON.parse(responseText) as unknown;
    } catch {
      throw new ToolFailure("VERIFICATION_FAILED", "Public API returned invalid JSON");
    }
    return PublicStateOutputSchema.parse({ statusCode: response.status, body });
  }

  async inspectProjectionCase(input: unknown) {
    const { orderId, projectionName } = ProjectionCaseInputSchema.parse(input);
    const [rowResult, checkpointResult, gapsResult] = await Promise.all([
      this.readPool.query<ProjectionRow>(
        `SELECT
           order_id, total_cents::text, paid_cents::text, payment_status,
           fulfillment_status, last_stream_version, row_version::text
         FROM order_view WHERE order_id = $1`,
        [orderId],
      ),
      this.readPool.query<{ last_global_position: string }>(
        `SELECT last_global_position::text
         FROM projection_checkpoints WHERE projection_name = $1`,
        [projectionName],
      ),
      this.readPool.query<{ global_position: string }>(
        `SELECT global_position::text
         FROM projection_gaps
         WHERE projection_name = $1
         ORDER BY global_position
         LIMIT 100`,
        [projectionName],
      ),
    ]);
    const row = rowResult.rows[0];
    return InspectCaseOutputSchema.parse({
      row: row === undefined ? null : canonicalRow(row),
      checkpoint: checkpointResult.rows[0]?.last_global_position ?? null,
      gapPositions: gapsResult.rows.map((gap) => gap.global_position),
    });
  }

  async snapshotEventStream(input: unknown) {
    const { streamId, maxEvents, maxCanonicalBytes } = SnapshotStreamInputSchema.parse(input);
    const head = await this.readPool.query<{ version: number }>(
      "SELECT version FROM event_streams WHERE stream_id = $1",
      [streamId],
    );
    const version = head.rows[0]?.version;
    if (version === undefined) {
      throw new ToolFailure("CASE_NOT_FOUND", "Event stream was not found");
    }
    if (version > maxEvents) {
      throw new ToolFailure("INVALID_EVENT_STREAM", "Event stream exceeds the count limit");
    }
    const metrics = await this.readPool.query<{ event_count: string; raw_bytes: string }>(
      `WITH bounded AS (
         SELECT event_id, global_position, stream_id, stream_version,
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
      [streamId, maxEvents + 1],
    );
    const metric = metrics.rows[0];
    if (metric === undefined || Number(metric.event_count) > maxEvents) {
      throw new ToolFailure("INVALID_EVENT_STREAM", "Event stream exceeds the count limit");
    }
    if (BigInt(metric.raw_bytes) > BigInt(maxCanonicalBytes)) {
      throw new ToolFailure("INVALID_EVENT_STREAM", "Event stream exceeds the byte limit");
    }
    const events = await new OrderEventStore(this.readPool).loadStream(streamId);
    const snapshot = snapshotEventStream({
      streamId,
      headVersion: version,
      events,
      maxEvents,
      maxCanonicalBytes,
    });
    return SnapshotOutputSchema.parse(snapshot);
  }

  async getProjectionRuntime(input: unknown) {
    const { projectionName } = RuntimeInputSchema.parse(input);
    const runtime = await getProjectionRuntime(this.readPool, projectionName);
    return RuntimeOutputSchema.parse({
      runtime:
        runtime === undefined
          ? null
          : {
              projectionName: runtime.projectionName,
              generation: runtime.generation,
              reducerSha256: runtime.reducerSha256,
              sourceCommitSha: runtime.sourceCommitSha,
              algorithmVersion: runtime.algorithmVersion,
              gapStrategy: runtime.gapStrategy,
            },
    });
  }

  async stageProjectionRepair(input: unknown) {
    const { envelope } = StageRepairInputSchema.parse(input);
    return StageOutputSchema.parse(await this.repairService.stageRepairPlan(envelope));
  }

  async verifyProjectionRepair(input: unknown) {
    const { planId, orderId } = VerifyRepairInputSchema.parse(input);
    const [plan, audit, row, publicState] = await Promise.all([
      this.readPool.query<{ status: string }>(
        "SELECT status FROM projection_repair_plans WHERE plan_id = $1",
        [planId],
      ),
      this.readPool.query<{ receipt_sha256: string; after_row_sha256: string }>(
        `SELECT receipt_sha256, after_row_sha256
         FROM projection_repair_audit WHERE plan_id = $1`,
        [planId],
      ),
      this.readPool.query<ProjectionRow>(
        `SELECT
           order_id, total_cents::text, paid_cents::text, payment_status,
           fulfillment_status, last_stream_version, row_version::text
         FROM order_view WHERE order_id = $1`,
        [orderId],
      ),
      this.getPublicOrderState({ orderId }),
    ]);
    const auditRow = audit.rows[0];
    const projectionRow = row.rows[0];
    let rowMatchesAudit: boolean | null = null;
    if (auditRow !== undefined && projectionRow !== undefined) {
      const { rowVersion: _rowVersion, ...business } = canonicalRow(projectionRow);
      rowMatchesAudit =
        fingerprintCandidateProjection(business).sha256 === auditRow.after_row_sha256;
    }
    return VerifyOutputSchema.parse({
      planStatus: plan.rows[0]?.status ?? null,
      auditReceiptSha256: auditRow?.receipt_sha256 ?? null,
      rowMatchesAudit,
      publicStatusCode: publicState.statusCode,
    });
  }

  async applyProjectionRepair(input: unknown) {
    const approval: ApplyProjectionRepairInput = ApplyRepairInputSchema.parse(input);
    return ApplyOutputSchema.parse(await this.repairService.applyRepairPlan(approval));
  }
}
