import {
  createDatabasePool,
  GapAwareAlgorithmVersion,
  migrateDatabase,
  OrderEventStore,
  registerProjectionRuntime,
  TrackedNonBlockingGapStrategy,
} from "@projection-witness/database";
import { ApprovedOrderReducerSha256 } from "@projection-witness/projector";
import {
  buildRepairEnvelope,
  canonicalSha256,
  fingerprintCandidateProjection,
  runReducerArtifactEvidence,
  type CurrentProjectionRow,
  type RepairEnvelope,
} from "@projection-witness/evidence";
import {
  ProjectionRepairService,
  RepairError,
  type ApplyProjectionRepairInput,
} from "@projection-witness/repair";
import { buildReducerBundle, type ReducerBundleResult } from "../../scripts/lib/reducer-bundle.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

function resealEnvelope(
  envelope: RepairEnvelope,
  overrides: Partial<Omit<RepairEnvelope, "evidenceSha256">>,
): RepairEnvelope {
  const { evidenceSha256: _evidenceSha256, ...unsigned } = { ...envelope, ...overrides };
  return { ...unsigned, evidenceSha256: canonicalSha256(unsigned) };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error("Deferred promise resolver was not initialized");
  }
  return { promise, resolve: resolvePromise };
}

const migratorUrl = environmentVariable("DATABASE_URL_MIGRATOR") ?? "";
const apiUrl = environmentVariable("DATABASE_URL_API") ?? "";
const projectorUrl = environmentVariable("DATABASE_URL_PROJECTOR") ?? "";
const mcpReadUrl = environmentVariable("DATABASE_URL_MCP_READ") ?? "";
const mcpWriteUrl = environmentVariable("DATABASE_URL_MCP_WRITE") ?? "";
const repairExecutorUrl = environmentVariable("DATABASE_URL_REPAIR_EXECUTOR") ?? "";
if (
  [migratorUrl, apiUrl, projectorUrl, mcpReadUrl, mcpWriteUrl, repairExecutorUrl].some(
    (value) => value === "",
  )
) {
  throw new Error("Projection repair tests require every runtime database URL");
}

interface RepairCase {
  envelope: RepairEnvelope;
  approval: ApplyProjectionRepairInput;
  projectionName: string;
  streamId: string;
}

describe("transactional projection repair", () => {
  let migratorPool: Pool;
  let apiPool: Pool;
  let projectorPool: Pool;
  let mcpReadPool: Pool;
  let mcpWritePool: Pool;
  let repairExecutorPool: Pool;
  let apiStore: OrderEventStore;
  let readStore: OrderEventStore;
  let reducerBundle: ReducerBundleResult;

  beforeAll(async () => {
    migratorPool = createDatabasePool({
      databaseUrl: migratorUrl,
      applicationName: "projection-witness-repair-migrator-test",
      maxConnections: 8,
    });
    apiPool = createDatabasePool({
      databaseUrl: apiUrl,
      applicationName: "projection-witness-repair-api-test",
      maxConnections: 4,
    });
    projectorPool = createDatabasePool({
      databaseUrl: projectorUrl,
      applicationName: "projection-witness-repair-projector-test",
      maxConnections: 4,
    });
    mcpReadPool = createDatabasePool({
      databaseUrl: mcpReadUrl,
      applicationName: "projection-witness-repair-read-test",
      maxConnections: 4,
    });
    mcpWritePool = createDatabasePool({
      databaseUrl: mcpWriteUrl,
      applicationName: "projection-witness-repair-write-test",
      maxConnections: 8,
    });
    repairExecutorPool = createDatabasePool({
      databaseUrl: repairExecutorUrl,
      applicationName: "projection-witness-repair-executor-test",
      maxConnections: 8,
    });
    await migrateDatabase(migratorPool);
    apiStore = new OrderEventStore(apiPool);
    readStore = new OrderEventStore(mcpReadPool);
    reducerBundle = await buildReducerBundle();
    expect(reducerBundle.sha256).toBe(ApprovedOrderReducerSha256);
  });

  afterAll(async () => {
    await Promise.all([
      mcpWritePool.end(),
      repairExecutorPool.end(),
      mcpReadPool.end(),
      projectorPool.end(),
      apiPool.end(),
      migratorPool.end(),
    ]);
  });

  function service(
    options: Partial<ConstructorParameters<typeof ProjectionRepairService>[1]> = {},
  ) {
    return new ProjectionRepairService(mcpWritePool, {
      executorPool: repairExecutorPool,
      reducerArtifactPath: reducerBundle.outputPath,
      ...options,
    });
  }

  async function createCase(
    options: { correctRow?: boolean; createdAt?: Date; ttlSeconds?: number } = {},
  ): Promise<RepairCase> {
    const suffix = randomUUID();
    const streamId = `ORD-REPAIR-${suffix}`;
    const projectionName = `orders-repair-${suffix}`;
    await apiStore.append({
      streamId,
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 12_900 },
    });
    await apiStore.append({
      streamId,
      expectedVersion: 1,
      event: { type: "PaymentCaptured", paymentId: `PAY-${suffix}`, amountCents: 12_900 },
    });
    const correctRow = options.correctRow ?? false;
    await projectorPool.query(
      `INSERT INTO order_view (
         order_id, total_cents, paid_cents, payment_status,
         fulfillment_status, last_stream_version, row_version
       )
       VALUES ($1, 12900, $2, $3, 'NOT_SHIPPED', $4, 1)`,
      [
        streamId,
        correctRow ? 12_900 : 0,
        correctRow ? "PAID" : "AWAITING_PAYMENT",
        correctRow ? 2 : 1,
      ],
    );
    await registerProjectionRuntime(projectorPool, {
      projectionName,
      generation: "2",
      reducerSha256: reducerBundle.sha256,
      sourceCommitSha: "repair-integration-commit",
      algorithmVersion: GapAwareAlgorithmVersion,
      gapStrategy: TrackedNonBlockingGapStrategy,
    });
    const events = await readStore.loadStream(streamId);
    const reducerEvidence = await runReducerArtifactEvidence(reducerBundle.outputPath, {
      schemaVersion: 1,
      expectedReducerSha256: reducerBundle.sha256,
      streamId,
      headVersion: 2,
      events,
    });
    const currentRow: CurrentProjectionRow = {
      orderId: streamId,
      totalCents: "12900",
      paidCents: correctRow ? "12900" : "0",
      paymentStatus: correctRow ? "PAID" : "AWAITING_PAYMENT",
      fulfillmentStatus: "NOT_SHIPPED",
      lastStreamVersion: correctRow ? 2 : 1,
      rowVersion: "1",
    };
    const createdAt = options.createdAt ?? new Date(Date.now() - 1_000);
    const envelope = buildRepairEnvelope({
      planId: randomUUID(),
      projectionName,
      runtime: {
        projectionName,
        generation: "2",
        reducerSha256: reducerBundle.sha256,
        sourceCommitSha: "repair-integration-commit",
        algorithmVersion: GapAwareAlgorithmVersion,
        gapStrategy: TrackedNonBlockingGapStrategy,
      },
      currentRow,
      reducerEvidence,
      clock: () => createdAt,
      ttlSeconds: options.ttlSeconds ?? 300,
    });
    return {
      envelope,
      approval: {
        planId: envelope.planId,
        projectionName,
        streamId,
        streamSha256: envelope.stream.sha256,
        currentRowVersion: envelope.currentRow.rowVersion,
        currentRowSha256: envelope.currentRow.sha256,
        reducerSha256: envelope.runtime.reducerSha256,
        runtimeGeneration: envelope.runtime.generation,
        evidenceSha256: envelope.evidenceSha256,
        expiresAt: envelope.expiresAt,
        trueforgeSessionId: "session-test",
        trueforgeTurnId: "turn-test",
        trueforgeToolCallId: "tool-test",
      },
      projectionName,
      streamId,
    };
  }

  async function expectZeroRepairWrites(testCase: RepairCase): Promise<void> {
    const plan = await migratorPool.query<{ status: string; applied_at: Date | null }>(
      `SELECT status, applied_at
       FROM projection_repair_plans
       WHERE plan_id = $1`,
      [testCase.envelope.planId],
    );
    const audit = await migratorPool.query(
      "SELECT 1 FROM projection_repair_audit WHERE plan_id = $1",
      [testCase.envelope.planId],
    );
    expect(plan.rows[0]).toEqual({ status: "PREPARED", applied_at: null });
    expect(audit.rowCount).toBe(0);
  }

  async function expectRepairError(
    operation: Promise<unknown>,
    code: RepairError["code"],
    category?: string,
  ): Promise<void> {
    try {
      await operation;
      throw new Error("Expected repair operation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RepairError);
      expect((error as RepairError).code).toBe(code);
      if (category !== undefined) {
        expect((error as RepairError).mismatchCategories).toContain(category);
      }
    }
  }

  it("stages idempotently, applies one row atomically, and returns the same receipt", async () => {
    const testCase = await createCase();
    const repair = service();
    expect(await repair.stageRepairPlan(testCase.envelope)).toMatchObject({ created: true });
    expect(await repair.stageRepairPlan(testCase.envelope)).toMatchObject({ created: false });

    const applied = await repair.applyRepairPlan(testCase.approval);
    expect(applied).toMatchObject({ status: "APPLIED", planId: testCase.envelope.planId });
    const row = await migratorPool.query<{
      paid_cents: string;
      payment_status: string;
      last_stream_version: number;
      row_version: string;
    }>(
      `SELECT paid_cents::text, payment_status, last_stream_version, row_version::text
       FROM order_view WHERE order_id = $1`,
      [testCase.streamId],
    );
    expect(row.rows[0]).toEqual({
      paid_cents: "12900",
      payment_status: "PAID",
      last_stream_version: 2,
      row_version: "2",
    });
    const runtimeBlocker = await migratorPool.connect();
    try {
      await runtimeBlocker.query("BEGIN");
      await runtimeBlocker.query(
        "SELECT 1 FROM projection_runtime WHERE projection_name = $1 FOR UPDATE",
        [testCase.projectionName],
      );
      const repeated = await service({ lockTimeoutMs: 100 }).applyRepairPlan(testCase.approval);
      expect(repeated).toEqual({ ...applied, status: "ALREADY_APPLIED" });
    } finally {
      await runtimeBlocker.query("ROLLBACK").catch(() => undefined);
      runtimeBlocker.release();
    }
  });

  it("refuses noncanonical timestamps, forged candidates, and unsafe cents at staging", async () => {
    const repair = service();
    const timestampCase = await createCase();
    const timestampEnvelope = resealEnvelope(timestampCase.envelope, {
      createdAt: timestampCase.envelope.createdAt.replace("Z", "+00:00"),
      expiresAt: timestampCase.envelope.expiresAt.replace("Z", "+00:00"),
    });
    await expectRepairError(repair.stageRepairPlan(timestampEnvelope), "PLAN_INVALID");

    const forgedCase = await createCase();
    const forgedCandidate = fingerprintCandidateProjection({
      ...forgedCase.envelope.candidateRow.value,
      paidCents: "1",
      paymentStatus: "PARTIALLY_PAID",
    });
    await expectRepairError(
      repair.stageRepairPlan(
        resealEnvelope(forgedCase.envelope, { candidateRow: forgedCandidate }),
      ),
      "PLAN_INVALID",
    );

    const unsafeCase = await createCase();
    const unsafeCandidate = fingerprintCandidateProjection({
      ...unsafeCase.envelope.candidateRow.value,
      totalCents: "9007199254740992",
      paidCents: "9007199254740992",
    });
    await expectRepairError(
      repair.stageRepairPlan(
        resealEnvelope(unsafeCase.envelope, { candidateRow: unsafeCandidate }),
      ),
      "PLAN_INVALID",
    );
  });

  it("refuses a concurrent stream change with zero repair writes", async () => {
    const testCase = await createCase();
    const repair = service();
    await repair.stageRepairPlan(testCase.envelope);
    await apiStore.append({
      streamId: testCase.streamId,
      expectedVersion: 2,
      event: { type: "OrderShipped", shipmentId: `SHIP-${randomUUID()}` },
    });

    await expectRepairError(repair.applyRepairPlan(testCase.approval), "STALE_PLAN", "stream");
    await expectZeroRepairWrites(testCase);
  });

  it("refuses row and runtime changes with zero repair writes", async () => {
    const rowCase = await createCase();
    const repair = service();
    await repair.stageRepairPlan(rowCase.envelope);
    await projectorPool.query(
      "UPDATE order_view SET row_version = row_version + 1 WHERE order_id = $1",
      [rowCase.streamId],
    );
    await expectRepairError(repair.applyRepairPlan(rowCase.approval), "STALE_PLAN", "row");
    await expectZeroRepairWrites(rowCase);

    const runtimeCase = await createCase();
    await repair.stageRepairPlan(runtimeCase.envelope);
    await registerProjectionRuntime(projectorPool, {
      projectionName: runtimeCase.projectionName,
      generation: "3",
      reducerSha256: reducerBundle.sha256,
      sourceCommitSha: "repair-integration-commit-v2",
      algorithmVersion: GapAwareAlgorithmVersion,
      gapStrategy: TrackedNonBlockingGapStrategy,
    });
    await expectRepairError(repair.applyRepairPlan(runtimeCase.approval), "STALE_PLAN", "runtime");
    await expectZeroRepairWrites(runtimeCase);
  });

  it("refuses expired plans, approval mismatch, and already-correct rows without writes", async () => {
    const expired = await createCase({ createdAt: new Date("2020-01-01T00:00:00.000Z") });
    const repair = service();
    await repair.stageRepairPlan(expired.envelope);
    await expectRepairError(repair.applyRepairPlan(expired.approval), "PLAN_EXPIRED");
    await expectZeroRepairWrites(expired);

    const mismatch = await createCase();
    await repair.stageRepairPlan(mismatch.envelope);
    await expectRepairError(
      repair.applyRepairPlan({ ...mismatch.approval, streamSha256: "f".repeat(64) }),
      "PLAN_INVALID",
    );
    await expectZeroRepairWrites(mismatch);

    const noOp = await createCase({ correctRow: true });
    await repair.stageRepairPlan(noOp.envelope);
    await expectRepairError(repair.applyRepairPlan(noOp.approval), "NOOP_ALREADY_CORRECT");
    await expectZeroRepairWrites(noOp);
  });

  it("rolls back the row update when audit insertion fails", async () => {
    const testCase = await createCase();
    const repair = service({
      beforeAuditInsert: async () => {
        throw new Error("injected audit failure");
      },
    });
    await repair.stageRepairPlan(testCase.envelope);
    await expectRepairError(repair.applyRepairPlan(testCase.approval), "APPLY_FAILED");
    await expectZeroRepairWrites(testCase);
    const row = await migratorPool.query<{ paid_cents: string; row_version: string }>(
      "SELECT paid_cents::text, row_version::text FROM order_view WHERE order_id = $1",
      [testCase.streamId],
    );
    expect(row.rows[0]).toEqual({ paid_cents: "0", row_version: "1" });
  });

  it("holds the stream lock so a concurrent append commits only after repair", async () => {
    const testCase = await createCase();
    const locksHeld = deferred();
    const releaseLocks = deferred();
    const repair = service({
      afterLocks: async () => {
        locksHeld.resolve();
        await releaseLocks.promise;
      },
    });
    await repair.stageRepairPlan(testCase.envelope);
    const applyPromise = repair.applyRepairPlan(testCase.approval);
    try {
      await locksHeld.promise;
      let appendSettled = false;
      const appendPromise = apiStore
        .append({
          streamId: testCase.streamId,
          expectedVersion: 2,
          event: { type: "OrderShipped", shipmentId: `SHIP-${randomUUID()}` },
        })
        .finally(() => {
          appendSettled = true;
        });
      await Promise.resolve();
      expect(appendSettled).toBe(false);

      releaseLocks.resolve();
      expect((await applyPromise).status).toBe("APPLIED");
      const appended = await appendPromise;
      expect(appended.streamVersion).toBe(3);
    } finally {
      releaseLocks.resolve();
      await applyPromise.catch(() => undefined);
    }
  });

  it("bounds plan-lock contention and leaves zero repair writes", async () => {
    const testCase = await createCase();
    const repair = service({ lockTimeoutMs: 100 });
    await repair.stageRepairPlan(testCase.envelope);
    const blocker = await migratorPool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM projection_repair_plans WHERE plan_id = $1 FOR UPDATE", [
        testCase.envelope.planId,
      ]);
      await expectRepairError(repair.applyRepairPlan(testCase.approval), "LOCK_TIMEOUT");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    await expectZeroRepairWrites(testCase);
  });

  it("refuses a stream over the configured event limit before materializing it", async () => {
    const testCase = await createCase();
    await service().stageRepairPlan(testCase.envelope);
    await expectRepairError(
      service({ maxEvents: 1 }).applyRepairPlan(testCase.approval),
      "PLAN_INVALID",
    );
    await expectZeroRepairWrites(testCase);
  });

  it("enforces immutable plan evidence, append-only audit, and read-role permissions", async () => {
    const testCase = await createCase();
    const repair = service();
    await repair.stageRepairPlan(testCase.envelope);
    await expect(
      mcpWritePool.query(
        "UPDATE projection_repair_plans SET stream_sha256 = $2 WHERE plan_id = $1",
        [testCase.envelope.planId, "f".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      mcpWritePool.query(
        "UPDATE projection_repair_plans SET status = 'APPLIED', applied_at = clock_timestamp() WHERE plan_id = $1",
        [testCase.envelope.planId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      repairExecutorPool.query(
        "UPDATE projection_repair_plans SET stream_sha256 = $2 WHERE plan_id = $1",
        [testCase.envelope.planId, "f".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      mcpWritePool.query(
        "UPDATE projection_runtime SET projection_name = projection_name WHERE projection_name = $1",
        [testCase.projectionName],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      mcpWritePool.query("UPDATE event_streams SET stream_id = stream_id WHERE stream_id = $1", [
        testCase.streamId,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      mcpWritePool.query("UPDATE order_view SET order_id = $2 WHERE order_id = $1", [
        testCase.streamId,
        `MOVED-${testCase.streamId}`,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      mcpWritePool.query("UPDATE order_view SET paid_cents = 1 WHERE order_id = $1", [
        testCase.streamId,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      repairExecutorPool.query("UPDATE order_view SET order_id = $2 WHERE order_id = $1", [
        testCase.streamId,
        `EXECUTOR-MOVED-${testCase.streamId}`,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await repair.applyRepairPlan(testCase.approval);
    await expect(
      migratorPool.query(
        "UPDATE projection_repair_audit SET receipt_sha256 = $2 WHERE plan_id = $1",
        [testCase.envelope.planId, "f".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      migratorPool.query("DELETE FROM projection_repair_audit WHERE plan_id = $1", [
        testCase.envelope.planId,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    expect(
      (
        await mcpReadPool.query("SELECT 1 FROM projection_repair_audit WHERE plan_id = $1", [
          testCase.envelope.planId,
        ])
      ).rowCount,
    ).toBe(1);
    await expect(
      mcpReadPool.query(
        "UPDATE projection_repair_plans SET status = 'APPLIED' WHERE plan_id = $1",
        [testCase.envelope.planId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
