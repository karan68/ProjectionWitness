import {
  createDatabasePool,
  GapAwareAlgorithmVersion,
  getProjectionRuntime,
  migrateDatabase,
  OrderEventStore,
  registerProjectionRuntime,
  TrackedNonBlockingGapStrategy,
} from "@projection-witness/database";
import { waitForCommitGate } from "@projection-witness/demo-driver";
import { GapAwareOrderProjector, NaiveOrderProjector } from "@projection-witness/projector";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const migratorUrl = environmentVariable("DATABASE_URL_MIGRATOR") ?? "";
const projectorUrl = environmentVariable("DATABASE_URL_PROJECTOR") ?? "";
const describeWithDatabase = migratorUrl === "" || projectorUrl === "" ? describe.skip : describe;

describeWithDatabase("gap-aware projector and runtime", () => {
  let migratorPool: Pool;
  let projectorPool: Pool;
  let eventStore: OrderEventStore;

  beforeAll(async () => {
    migratorPool = createDatabasePool({
      databaseUrl: migratorUrl,
      applicationName: "projection-witness-gap-aware-migrator-test",
      maxConnections: 8,
    });
    projectorPool = createDatabasePool({
      databaseUrl: projectorUrl,
      applicationName: "projection-witness-gap-aware-projector-test",
      maxConnections: 4,
    });
    await migrateDatabase(migratorPool);
    eventStore = new OrderEventStore(migratorPool);
  });

  afterAll(async () => {
    await projectorPool.end();
    await migratorPool.end();
  });

  async function isolatedProjectionName(prefix: string): Promise<string> {
    const projectionName = `${prefix}-${randomUUID()}`;
    await migratorPool.query(
      `INSERT INTO projection_checkpoints (projection_name, last_global_position)
       SELECT $1, COALESCE(max(global_position), 0)
       FROM events`,
      [projectionName],
    );
    return projectionName;
  }

  async function seedOrders(
    projector: GapAwareOrderProjector | NaiveOrderProjector,
    targetOrderId: string,
    unrelatedOrderId: string,
  ): Promise<void> {
    await eventStore.append({
      streamId: targetOrderId,
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 12_900 },
    });
    await eventStore.append({
      streamId: unrelatedOrderId,
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 5_000 },
    });
    expect((await projector.poll()).processedCount).toBe(2);
  }

  it("registers runtime manifests idempotently and requires increasing generations", async () => {
    const projectionName = `runtime-${randomUUID()}`;
    const manifest = {
      projectionName,
      generation: "2",
      reducerSha256: "a".repeat(64),
      sourceCommitSha: "commit-a",
      algorithmVersion: GapAwareAlgorithmVersion,
      gapStrategy: TrackedNonBlockingGapStrategy,
    };

    const first = await registerProjectionRuntime(projectorPool, manifest);
    const repeated = await registerProjectionRuntime(projectorPool, manifest);
    expect(repeated).toEqual(first);
    await expect(
      registerProjectionRuntime(projectorPool, {
        ...manifest,
        reducerSha256: "b".repeat(64),
      }),
    ).rejects.toThrow(/generation must increase/);

    const updated = await registerProjectionRuntime(projectorPool, {
      ...manifest,
      generation: "3",
      reducerSha256: "b".repeat(64),
    });
    expect(updated.generation).toBe("3");
    expect((await getProjectionRuntime(projectorPool, projectionName))?.reducerSha256).toBe(
      "b".repeat(64),
    );
  });

  it("accepts the PostgreSQL bigint maximum and rejects overflow before registration", async () => {
    const acceptedProjectionName = `runtime-int64-${randomUUID()}`;
    const manifest = {
      projectionName: acceptedProjectionName,
      generation: "9223372036854775807",
      reducerSha256: "a".repeat(64),
      sourceCommitSha: "commit-int64",
      algorithmVersion: GapAwareAlgorithmVersion,
      gapStrategy: TrackedNonBlockingGapStrategy,
    };

    expect((await registerProjectionRuntime(projectorPool, manifest)).generation).toBe(
      "9223372036854775807",
    );
    const rejectedProjectionName = `runtime-overflow-${randomUUID()}`;
    await expect(
      registerProjectionRuntime(projectorPool, {
        ...manifest,
        projectionName: rejectedProjectionName,
        generation: "9223372036854775808",
      }),
    ).rejects.toThrow(/signed 64-bit PostgreSQL bigint/);
    expect(await getProjectionRuntime(projectorPool, rejectedProjectionName)).toBeUndefined();

    await expect(
      registerProjectionRuntime(projectorPool, {
        ...manifest,
        projectionName: `runtime-unbounded-${randomUUID()}`,
        generation: "9".repeat(10_000),
      }),
    ).rejects.toThrow(/at most 19 digits/);
  });

  it("tracks a new commit gap, continues unrelated work, and resolves the delayed event", async () => {
    const projectionName = await isolatedProjectionName("orders-v2-gap");
    const projector = new GapAwareOrderProjector(projectorPool, { projectionName });
    const suffix = randomUUID();
    const targetOrderId = `ORD-V2-A-${suffix}`;
    const unrelatedOrderId = `ORD-V2-B-${suffix}`;
    await seedOrders(projector, targetOrderId, unrelatedOrderId);

    const gateReached = deferred();
    const releaseCommit = deferred();
    let pendingPosition: string | undefined;
    const gatedStore = new OrderEventStore(migratorPool, {
      beforeCommit: async (event) => {
        pendingPosition = event.globalPosition;
        gateReached.resolve();
        await releaseCommit.promise;
      },
    });
    const pendingPayment = gatedStore.append({
      streamId: targetOrderId,
      expectedVersion: 1,
      event: { type: "PaymentCaptured", paymentId: "PAY-V2", amountCents: 12_900 },
    });

    try {
      await waitForCommitGate(gateReached.promise, pendingPayment);
      const laterShipment = await eventStore.append({
        streamId: unrelatedOrderId,
        expectedVersion: 1,
        event: { type: "OrderShipped", shipmentId: "SHIP-V2" },
      });
      const gapPoll = await projector.poll();
      expect(gapPoll.checkpointAfter).toBe(laterShipment.globalPosition);
      expect(gapPoll.trackedGapPositions).toContain(pendingPosition);
      expect(gapPoll.processedGlobalPositions).toEqual([laterShipment.globalPosition]);

      releaseCommit.resolve();
      await pendingPayment;
      const recoveryPoll = await projector.poll();
      expect(recoveryPoll.resolvedGapPositions).toEqual([pendingPosition]);

      const row = await migratorPool.query<{
        paid_cents: string;
        payment_status: string;
        last_stream_version: number;
      }>(
        `SELECT paid_cents::text, payment_status, last_stream_version
         FROM order_view
         WHERE order_id = $1`,
        [targetOrderId],
      );
      expect(row.rows[0]).toEqual({
        paid_cents: "12900",
        payment_status: "PAID",
        last_stream_version: 2,
      });
    } finally {
      releaseCommit.resolve();
      await pendingPayment.catch(() => undefined);
    }
  });

  it("does not invent a historical gap skipped before v2 deployment", async () => {
    const projectionName = await isolatedProjectionName("orders-v1-history");
    const naiveProjector = new NaiveOrderProjector(projectorPool, { projectionName });
    const suffix = randomUUID();
    const targetOrderId = `ORD-HIST-A-${suffix}`;
    const unrelatedOrderId = `ORD-HIST-B-${suffix}`;
    await seedOrders(naiveProjector, targetOrderId, unrelatedOrderId);

    const gateReached = deferred();
    const releaseCommit = deferred();
    let pendingPosition: string | undefined;
    const gatedStore = new OrderEventStore(migratorPool, {
      beforeCommit: async (event) => {
        pendingPosition = event.globalPosition;
        gateReached.resolve();
        await releaseCommit.promise;
      },
    });
    const pendingPayment = gatedStore.append({
      streamId: targetOrderId,
      expectedVersion: 1,
      event: { type: "PaymentCaptured", paymentId: "PAY-HIST", amountCents: 12_900 },
    });

    try {
      await waitForCommitGate(gateReached.promise, pendingPayment);
      await eventStore.append({
        streamId: unrelatedOrderId,
        expectedVersion: 1,
        event: { type: "OrderShipped", shipmentId: "SHIP-HIST" },
      });
      await naiveProjector.poll();
      releaseCommit.resolve();
      await pendingPayment;

      const gapAwareProjector = new GapAwareOrderProjector(projectorPool, { projectionName });
      const deploymentPoll = await gapAwareProjector.poll();
      expect(deploymentPoll.processedCount).toBe(0);
      expect(deploymentPoll.trackedGapPositions).toEqual([]);
      const gaps = await migratorPool.query(
        `SELECT 1 FROM projection_gaps
         WHERE projection_name = $1 AND global_position = $2::bigint`,
        [projectionName, pendingPosition],
      );
      expect(gaps.rowCount).toBe(0);

      const row = await migratorPool.query<{ paid_cents: string; last_stream_version: number }>(
        `SELECT paid_cents::text, last_stream_version
         FROM order_view
         WHERE order_id = $1`,
        [targetOrderId],
      );
      expect(row.rows[0]).toEqual({ paid_cents: "0", last_stream_version: 1 });

      const laterTargetEvent = await eventStore.append({
        streamId: targetOrderId,
        expectedVersion: 2,
        event: { type: "OrderShipped", shipmentId: "SHIP-HIST-TARGET" },
      });
      const blockedPoll = await gapAwareProjector.poll();
      expect(blockedPoll.processedGlobalPositions).not.toContain(laterTargetEvent.globalPosition);
      const blockedGap = await migratorPool.query(
        `SELECT 1 FROM projection_gaps
         WHERE projection_name = $1 AND global_position = $2::bigint`,
        [projectionName, laterTargetEvent.globalPosition],
      );
      expect(blockedGap.rowCount).toBe(1);
      const stillUnchanged = await migratorPool.query<{
        fulfillment_status: string;
        last_stream_version: number;
      }>(
        `SELECT fulfillment_status, last_stream_version
         FROM order_view
         WHERE order_id = $1`,
        [targetOrderId],
      );
      expect(stillUnchanged.rows[0]).toEqual({
        fulfillment_status: "NOT_SHIPPED",
        last_stream_version: 1,
      });
    } finally {
      releaseCommit.resolve();
      await pendingPayment.catch(() => undefined);
    }
  });

  it("retires only old, distant positions that remain permanent sequence holes", async () => {
    const projectionName = await isolatedProjectionName("orders-v2-retirement");
    const projector = new GapAwareOrderProjector(projectorPool, {
      projectionName,
      gapRetentionDistance: 1,
      gapRetentionMs: 60_000,
    });
    const hole = await migratorPool.query<{ position: string }>(
      "SELECT nextval('event_global_position_seq')::text AS position",
    );
    const holePosition = hole.rows[0]?.position;
    expect(holePosition).toBeDefined();
    await eventStore.append({
      streamId: `ORD-HOLE-RETIRE-${randomUUID()}`,
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 100 },
    });

    const observed = await projector.poll();
    expect(observed.trackedGapPositions).toContain(holePosition);
    await migratorPool.query(
      `UPDATE projection_gaps
       SET first_observed_at = clock_timestamp() - interval '2 minutes'
       WHERE projection_name = $1 AND global_position = $2::bigint`,
      [projectionName, holePosition],
    );

    const retired = await projector.poll();
    expect(retired.retiredGapPositions).toEqual([holePosition]);
    const remaining = await migratorPool.query(
      `SELECT 1 FROM projection_gaps
       WHERE projection_name = $1 AND global_position = $2::bigint`,
      [projectionName, holePosition],
    );
    expect(remaining.rowCount).toBe(0);
  });
});
