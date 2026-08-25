import {
  GapAwareAlgorithmVersion,
  getProjectionRuntime,
  loadOrderStream,
  registerProjectionRuntime,
  TrackedNonBlockingGapStrategy,
} from "@projection-witness/database";
import {
  buildRepairEnvelope,
  runReducerArtifactEvidence,
  type CurrentProjectionRow,
  type RepairEnvelope,
} from "@projection-witness/evidence";
import { ApprovedOrderReducerSha256 } from "@projection-witness/projector";
import {
  ApplyProjectionRepairInputSchema,
  ProjectionRepairService,
  type ApplyProjectionRepairInput,
  type StagedRepairPlan,
} from "@projection-witness/repair";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";

const DemoIdentifierSchema = z.string().trim().min(1).max(128);
const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

interface DemoProjectionRow {
  order_id: string;
  total_cents: string;
  paid_cents: string;
  payment_status: string;
  fulfillment_status: string;
  last_stream_version: number;
  row_version: string;
}

export interface ProjectionRepairDemoPools {
  projectorPool: Pool;
  readPool: Pool;
  stagingPool: Pool;
  executorPool: Pool;
}

export interface PrepareProjectionRepairDemoOptions {
  reducerArtifactPath: string;
  sourceCommitSha: string;
  targetOrderId?: string;
  projectionName?: string;
  ttlSeconds?: number;
  clock?: () => Date;
  generatePlanId?: () => string;
}

export interface PreparedProjectionRepairDemo {
  envelope: RepairEnvelope;
  approval: ApplyProjectionRepairInput;
  staged: StagedRepairPlan;
}

export const PreparedProjectionRepairDemoFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    approval: ApplyProjectionRepairInputSchema,
    summary: z
      .object({
        planId: z.uuid(),
        projectionName: DemoIdentifierSchema,
        streamId: DemoIdentifierSchema,
        streamHeadVersion: z.number().int().nonnegative().safe(),
        streamSha256: z.string().regex(/^[0-9a-f]{64}$/),
        reducerSha256: z.string().regex(/^[0-9a-f]{64}$/),
        runtimeGeneration: z.string().regex(/^[1-9][0-9]*$/),
        currentRowVersion: z.string().regex(/^[1-9][0-9]*$/),
        currentRowSha256: z.string().regex(/^[0-9a-f]{64}$/),
        candidateRowSha256: z.string().regex(/^[0-9a-f]{64}$/),
        expiresAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

export type PreparedProjectionRepairDemoFile = z.infer<
  typeof PreparedProjectionRepairDemoFileSchema
>;

function currentProjectionRow(row: DemoProjectionRow): CurrentProjectionRow {
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

function assertGenuineDemoGap(row: CurrentProjectionRow): void {
  if (
    row.totalCents !== "12900" ||
    row.paidCents !== "0" ||
    row.paymentStatus !== "AWAITING_PAYMENT" ||
    row.fulfillmentStatus !== "NOT_SHIPPED" ||
    row.lastStreamVersion !== 1 ||
    row.rowVersion !== "1"
  ) {
    throw new Error("Demo repair preparation requires the genuine unpaid stale projection row");
  }
}

export async function prepareProjectionRepairDemo(
  pools: ProjectionRepairDemoPools,
  input: PrepareProjectionRepairDemoOptions,
): Promise<PreparedProjectionRepairDemo> {
  const options = z
    .object({
      reducerArtifactPath: z.string().trim().min(1).max(1_024),
      sourceCommitSha: CommitShaSchema,
      targetOrderId: DemoIdentifierSchema.default("ORD-1042"),
      projectionName: DemoIdentifierSchema.default("orders"),
      ttlSeconds: z.number().int().positive().safe().max(3_600).default(300),
      clock: z.function().optional(),
      generatePlanId: z.function().optional(),
    })
    .strict()
    .parse(input);
  const rowResult = await pools.readPool.query<DemoProjectionRow>(
    `SELECT
       order_id, total_cents::text, paid_cents::text, payment_status,
       fulfillment_status, last_stream_version, row_version::text
     FROM order_view
     WHERE order_id = $1`,
    [options.targetOrderId],
  );
  const storedRow = rowResult.rows[0];
  if (storedRow === undefined) {
    throw new Error("Demo target projection row was not found");
  }
  const currentRow = currentProjectionRow(storedRow);
  assertGenuineDemoGap(currentRow);
  const headResult = await pools.readPool.query<{ version: number }>(
    "SELECT version FROM event_streams WHERE stream_id = $1",
    [options.targetOrderId],
  );
  const headVersion = headResult.rows[0]?.version;
  if (headVersion === undefined) {
    throw new Error("Demo target event stream was not found");
  }
  const events = await loadOrderStream(pools.readPool, options.targetOrderId, 1_001);
  if (events.length > 1_000) {
    throw new Error("Demo target event stream exceeds the event limit");
  }

  await registerProjectionRuntime(pools.projectorPool, {
    projectionName: options.projectionName,
    generation: "2",
    reducerSha256: ApprovedOrderReducerSha256,
    sourceCommitSha: options.sourceCommitSha,
    algorithmVersion: GapAwareAlgorithmVersion,
    gapStrategy: TrackedNonBlockingGapStrategy,
  });
  const runtime = await getProjectionRuntime(pools.readPool, options.projectionName);
  if (runtime === undefined) {
    throw new Error("Safe demo projection runtime was not registered");
  }
  const reducerEvidence = await runReducerArtifactEvidence(options.reducerArtifactPath, {
    schemaVersion: 1,
    expectedReducerSha256: runtime.reducerSha256,
    streamId: options.targetOrderId,
    headVersion,
    events,
  });
  const envelope = buildRepairEnvelope({
    planId: (options.generatePlanId as (() => string) | undefined)?.() ?? randomUUID(),
    projectionName: options.projectionName,
    runtime: {
      projectionName: runtime.projectionName,
      generation: runtime.generation,
      reducerSha256: runtime.reducerSha256,
      sourceCommitSha: runtime.sourceCommitSha,
      algorithmVersion: runtime.algorithmVersion,
      gapStrategy: runtime.gapStrategy,
    },
    currentRow,
    reducerEvidence,
    clock: (options.clock as (() => Date) | undefined) ?? (() => new Date()),
    ttlSeconds: options.ttlSeconds,
  });
  const repair = new ProjectionRepairService(pools.stagingPool, {
    executorPool: pools.executorPool,
    reducerArtifactPath: options.reducerArtifactPath,
  });
  const staged = await repair.stageRepairPlan(envelope);
  return {
    envelope,
    staged,
    approval: {
      planId: envelope.planId,
      projectionName: envelope.projectionName,
      streamId: envelope.stream.streamId,
      streamSha256: envelope.stream.sha256,
      currentRowVersion: envelope.currentRow.rowVersion,
      currentRowSha256: envelope.currentRow.sha256,
      reducerSha256: envelope.runtime.reducerSha256,
      runtimeGeneration: envelope.runtime.generation,
      evidenceSha256: envelope.evidenceSha256,
      expiresAt: envelope.expiresAt,
    },
  };
}
