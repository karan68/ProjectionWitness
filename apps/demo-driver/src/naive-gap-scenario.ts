import { buildOrderApi } from "@projection-witness/api";
import { OrderEventStore } from "@projection-witness/database";
import {
  OrderProjectionSchema,
  versionOrderEvent,
  type OrderProjection,
} from "@projection-witness/domain";
import { NaiveOrderProjector } from "@projection-witness/projector";
import { reduceOrder } from "@projection-witness/reducer";
import type { Pool } from "pg";

const ProjectionName = "orders";
const TargetOrderId = "ORD-1042";
const UnrelatedOrderId = "ORD-2048";

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

async function readCustomerOrder(pool: Pool): Promise<OrderProjection> {
  const api = buildOrderApi(pool);
  try {
    const response = await api.inject({ method: "GET", url: `/orders/${TargetOrderId}` });
    if (response.statusCode !== 200) {
      throw new Error(`Order API returned HTTP ${String(response.statusCode)}`);
    }
    return OrderProjectionSchema.parse(response.json());
  } finally {
    await api.close();
  }
}

async function replayTargetOrder(eventStore: OrderEventStore): Promise<OrderProjection> {
  const stream = await eventStore.loadStream(TargetOrderId);
  const replayed = stream.reduce<OrderProjection | null>(
    (state, stored) =>
      reduceOrder(state, versionOrderEvent(stored.streamId, stored.streamVersion, stored.payload)),
    null,
  );
  if (replayed === null) {
    throw new Error("Target order stream is empty");
  }
  return replayed;
}

export interface NaiveGapEvidence {
  targetOrderId: string;
  pendingPaymentPosition: string;
  unrelatedCommittedPosition: string;
  checkpointPosition: string;
  customerState: OrderProjection;
  replayedState: OrderProjection;
  laterPollProcessedCount: number;
}

export async function resetNaiveGapFixture(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "TRUNCATE projection_gaps, projection_checkpoints, order_view, events, event_streams CASCADE",
    );
    await client.query("ALTER SEQUENCE event_global_position_seq RESTART WITH 1");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reproduceNaiveGap(pool: Pool): Promise<NaiveGapEvidence> {
  const eventStore = new OrderEventStore(pool);
  const projector = new NaiveOrderProjector(pool, { projectionName: ProjectionName });
  await eventStore.append({
    streamId: TargetOrderId,
    expectedVersion: 0,
    event: { type: "OrderPlaced", totalCents: 12_900 },
  });
  await eventStore.append({
    streamId: UnrelatedOrderId,
    expectedVersion: 0,
    event: { type: "OrderPlaced", totalCents: 5_000 },
  });
  const initialPoll = await projector.poll();
  if (initialPoll.processedCount !== 2) {
    throw new Error("Fixture projector poll did not process both initial orders");
  }

  const gateReached = deferred();
  const releaseCommit = deferred();
  const gatedStore = new OrderEventStore(pool, {
    beforeCommit: async () => {
      gateReached.resolve();
      await releaseCommit.promise;
    },
  });
  const pendingPayment = gatedStore.append({
    streamId: TargetOrderId,
    expectedVersion: 1,
    event: {
      type: "PaymentCaptured",
      paymentId: "PAY-1042",
      amountCents: 12_900,
    },
  });

  try {
    await gateReached.promise;
    const unrelatedEvent = await eventStore.append({
      streamId: UnrelatedOrderId,
      expectedVersion: 1,
      event: { type: "OrderShipped", shipmentId: "SHIP-2048" },
    });
    const gapPoll = await projector.poll();
    if (gapPoll.processedGlobalPositions.length !== 1) {
      throw new Error("Gap projector poll did not process exactly one visible event");
    }

    releaseCommit.resolve();
    const payment = await pendingPayment;
    const customerState = await readCustomerOrder(pool);
    const replayedState = await replayTargetOrder(eventStore);
    const laterPoll = await projector.poll();

    return {
      targetOrderId: TargetOrderId,
      pendingPaymentPosition: payment.globalPosition,
      unrelatedCommittedPosition: unrelatedEvent.globalPosition,
      checkpointPosition: gapPoll.checkpointAfter,
      customerState,
      replayedState,
      laterPollProcessedCount: laterPoll.processedCount,
    };
  } finally {
    releaseCommit.resolve();
    await pendingPayment.catch(() => undefined);
  }
}

export async function verifyNaiveGap(pool: Pool): Promise<{
  customerState: OrderProjection;
  replayedState: OrderProjection;
  checkpointPosition: string;
}> {
  const eventStore = new OrderEventStore(pool);
  const customerState = await readCustomerOrder(pool);
  const replayedState = await replayTargetOrder(eventStore);
  const checkpointResult = await pool.query<{ last_global_position: string }>(
    `SELECT last_global_position::text
     FROM projection_checkpoints
     WHERE projection_name = $1`,
    [ProjectionName],
  );
  const checkpoint = checkpointResult.rows[0];
  if (checkpoint === undefined) {
    throw new Error("Orders checkpoint is missing");
  }
  if (
    customerState.paymentStatus !== "AWAITING_PAYMENT" ||
    replayedState.paymentStatus !== "PAID"
  ) {
    throw new Error("Expected API/stream payment mismatch is not present");
  }

  return {
    customerState,
    replayedState,
    checkpointPosition: checkpoint.last_global_position,
  };
}
