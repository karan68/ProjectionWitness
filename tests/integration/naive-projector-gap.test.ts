import { buildOrderApi } from "@projection-witness/api";
import { waitForCommitGate } from "@projection-witness/demo-driver";
import { OrderEventStore, createDatabasePool, migrateDatabase } from "@projection-witness/database";
import { versionOrderEvent, type OrderProjection } from "@projection-witness/domain";
import { NaiveOrderProjector } from "@projection-witness/projector";
import { reduceOrder } from "@projection-witness/reducer";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
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

const databaseUrl = environmentVariable("DATABASE_URL_MIGRATOR") ?? "";
if (databaseUrl === "") {
  throw new Error("Naive projector gap tests require DATABASE_URL_MIGRATOR");
}

describe("naive projector out-of-order commit gap", () => {
  let pool: Pool;
  let eventStore: OrderEventStore;
  let api: FastifyInstance;

  beforeAll(async () => {
    pool = createDatabasePool({
      databaseUrl,
      applicationName: "projection-witness-gap-test",
      maxConnections: 8,
    });
    await migrateDatabase(pool);
    eventStore = new OrderEventStore(pool);
    api = buildOrderApi(pool);
    await api.ready();
  });

  afterAll(async () => {
    await api.close();
    await pool.end();
  });

  async function seedAndProjectOrders(
    targetOrderId: string,
    unrelatedOrderId: string,
    projector: NaiveOrderProjector,
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
    const initialPoll = await projector.poll();
    expect(initialPoll.processedCount).toBe(2);
  }

  async function createIsolatedProjector(): Promise<NaiveOrderProjector> {
    const projectionName = `orders-gap-test-${randomUUID()}`;
    await pool.query(
      `INSERT INTO projection_checkpoints (projection_name, last_global_position)
       SELECT $1, COALESCE(max(global_position), 0)
       FROM events`,
      [projectionName],
    );
    return new NaiveOrderProjector(pool, { projectionName });
  }

  it("leaves a committed payment permanently behind the advanced checkpoint", async () => {
    const suffix = randomUUID();
    const targetOrderId = `ORD-GAP-A-${suffix}`;
    const unrelatedOrderId = `ORD-GAP-B-${suffix}`;
    const projector = await createIsolatedProjector();
    await seedAndProjectOrders(targetOrderId, unrelatedOrderId, projector);
    const gateReached = deferred();
    const releaseCommit = deferred();
    let pendingPosition: string | undefined;
    const gatedStore = new OrderEventStore(pool, {
      beforeCommit: async (event) => {
        pendingPosition = event.globalPosition;
        gateReached.resolve();
        await releaseCommit.promise;
      },
    });
    const pendingPayment = gatedStore.append({
      streamId: targetOrderId,
      expectedVersion: 1,
      event: {
        type: "PaymentCaptured",
        paymentId: "PAY-1042",
        amountCents: 12_900,
      },
    });

    try {
      await waitForCommitGate(gateReached.promise, pendingPayment);
      const unrelatedShipment = await eventStore.append({
        streamId: unrelatedOrderId,
        expectedVersion: 1,
        event: { type: "OrderShipped", shipmentId: "SHIP-2048" },
      });
      expect(BigInt(pendingPosition ?? "0")).toBeLessThan(BigInt(unrelatedShipment.globalPosition));

      const gapPoll = await projector.poll();
      expect(gapPoll.processedGlobalPositions).toEqual([unrelatedShipment.globalPosition]);
      expect(gapPoll.checkpointAfter).toBe(unrelatedShipment.globalPosition);

      releaseCommit.resolve();
      const payment = await pendingPayment;
      expect(payment.globalPosition).toBe(pendingPosition);

      const customerResponse = await api.inject({
        method: "GET",
        url: `/orders/${targetOrderId}`,
      });
      expect(customerResponse.statusCode).toBe(200);
      expect(customerResponse.json()).toMatchObject({
        paidCents: 0,
        paymentStatus: "AWAITING_PAYMENT",
        lastStreamVersion: 1,
      });

      const stream = await eventStore.loadStream(targetOrderId);
      const replayed = stream.reduce<OrderProjection | null>(
        (state, stored) =>
          reduceOrder(
            state,
            versionOrderEvent(stored.streamId, stored.streamVersion, stored.payload),
          ),
        null,
      );
      expect(replayed).toMatchObject({
        paidCents: 12_900,
        paymentStatus: "PAID",
        lastStreamVersion: 2,
      });

      const laterPoll = await projector.poll();
      expect(laterPoll.processedCount).toBe(0);
      expect(laterPoll.checkpointAfter).toBe(unrelatedShipment.globalPosition);
    } finally {
      releaseCommit.resolve();
      await pendingPayment.catch(() => undefined);
    }
  });

  it("ablation: projects the payment when both positions are visible before polling", async () => {
    const suffix = randomUUID();
    const targetOrderId = `ORD-ABLATION-A-${suffix}`;
    const unrelatedOrderId = `ORD-ABLATION-B-${suffix}`;
    const projector = await createIsolatedProjector();
    await seedAndProjectOrders(targetOrderId, unrelatedOrderId, projector);
    await eventStore.append({
      streamId: targetOrderId,
      expectedVersion: 1,
      event: {
        type: "PaymentCaptured",
        paymentId: "PAY-VISIBLE",
        amountCents: 12_900,
      },
    });
    await eventStore.append({
      streamId: unrelatedOrderId,
      expectedVersion: 1,
      event: { type: "OrderShipped", shipmentId: "SHIP-VISIBLE" },
    });

    const poll = await projector.poll();
    expect(poll.processedCount).toBe(2);

    const customerResponse = await api.inject({
      method: "GET",
      url: `/orders/${targetOrderId}`,
    });
    expect(customerResponse.json()).toMatchObject({
      paidCents: 12_900,
      paymentStatus: "PAID",
      lastStreamVersion: 2,
    });
  });

  it("treats an event already represented by the row as an idempotent no-op", async () => {
    const suffix = randomUUID();
    const targetOrderId = `ORD-NOOP-${suffix}`;
    const projector = await createIsolatedProjector();
    await eventStore.append({
      streamId: targetOrderId,
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 100 },
    });
    await pool.query(
      `INSERT INTO order_view (
         order_id,
         total_cents,
         paid_cents,
         payment_status,
         fulfillment_status,
         last_stream_version,
         row_version
       )
       VALUES ($1, 100, 100, 'PAID', 'NOT_SHIPPED', 1, 7)`,
      [targetOrderId],
    );

    const poll = await projector.poll();
    expect(poll.processedCount).toBe(1);
    const row = await pool.query<{
      paid_cents: string;
      last_stream_version: number;
      row_version: string;
    }>(
      `SELECT paid_cents::text, last_stream_version, row_version::text
       FROM order_view
       WHERE order_id = $1`,
      [targetOrderId],
    );
    expect(row.rows[0]).toEqual({
      paid_cents: "100",
      last_stream_version: 1,
      row_version: "7",
    });
  });
});
