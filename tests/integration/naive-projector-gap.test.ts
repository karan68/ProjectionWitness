import { buildOrderApi } from "@projection-witness/api";
import { OrderEventStore, createDatabasePool, migrateDatabase } from "@projection-witness/database";
import { versionOrderEvent, type OrderProjection } from "@projection-witness/domain";
import { NaiveOrderProjector } from "@projection-witness/projector";
import { reduceOrder } from "@projection-witness/reducer";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
const describeWithDatabase = databaseUrl === "" ? describe.skip : describe;

describeWithDatabase("naive projector out-of-order commit gap", () => {
  let pool: Pool;
  let eventStore: OrderEventStore;
  let projector: NaiveOrderProjector;
  let api: FastifyInstance;

  beforeAll(async () => {
    pool = createDatabasePool({
      databaseUrl,
      applicationName: "projection-witness-gap-test",
      maxConnections: 8,
    });
    await migrateDatabase(pool);
    eventStore = new OrderEventStore(pool);
    projector = new NaiveOrderProjector(pool);
    api = buildOrderApi(pool);
    await api.ready();
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE projection_gaps, projection_checkpoints, order_view, events, event_streams CASCADE",
    );
    await pool.query("ALTER SEQUENCE event_global_position_seq RESTART WITH 1");
  });

  afterAll(async () => {
    await api.close();
    await pool.end();
  });

  async function seedAndProjectOrders(): Promise<void> {
    await eventStore.append({
      streamId: "ORD-1042",
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 12_900 },
    });
    await eventStore.append({
      streamId: "ORD-2048",
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 5_000 },
    });
    const initialPoll = await projector.poll();
    expect(initialPoll.processedCount).toBe(2);
  }

  it("leaves a committed payment permanently behind the advanced checkpoint", async () => {
    await seedAndProjectOrders();
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
      streamId: "ORD-1042",
      expectedVersion: 1,
      event: {
        type: "PaymentCaptured",
        paymentId: "PAY-1042",
        amountCents: 12_900,
      },
    });

    try {
      await gateReached.promise;
      const unrelatedShipment = await eventStore.append({
        streamId: "ORD-2048",
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

      const customerResponse = await api.inject({ method: "GET", url: "/orders/ORD-1042" });
      expect(customerResponse.statusCode).toBe(200);
      expect(customerResponse.json()).toMatchObject({
        paidCents: 0,
        paymentStatus: "AWAITING_PAYMENT",
        lastStreamVersion: 1,
      });

      const stream = await eventStore.loadStream("ORD-1042");
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
    await seedAndProjectOrders();
    await eventStore.append({
      streamId: "ORD-1042",
      expectedVersion: 1,
      event: {
        type: "PaymentCaptured",
        paymentId: "PAY-VISIBLE",
        amountCents: 12_900,
      },
    });
    await eventStore.append({
      streamId: "ORD-2048",
      expectedVersion: 1,
      event: { type: "OrderShipped", shipmentId: "SHIP-VISIBLE" },
    });

    const poll = await projector.poll();
    expect(poll.processedCount).toBe(2);

    const customerResponse = await api.inject({ method: "GET", url: "/orders/ORD-1042" });
    expect(customerResponse.json()).toMatchObject({
      paidCents: 12_900,
      paymentStatus: "PAID",
      lastStreamVersion: 2,
    });
  });
});
