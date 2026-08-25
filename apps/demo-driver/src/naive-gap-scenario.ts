import { buildOrderApi } from "@projection-witness/api";
import { OrderEventStore } from "@projection-witness/database";
import {
  OrderProjectionSchema,
  versionOrderEvent,
  type OrderProjection,
} from "@projection-witness/domain";
import { NaiveOrderProjector } from "@projection-witness/projector";
import { reduceOrder } from "@projection-witness/reducer";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { z } from "zod";

const DefaultProjectionName = "orders";
const DefaultTargetOrderId = "ORD-1042";
const DefaultUnrelatedOrderId = "ORD-2048";
const ScenarioIdentifierSchema = z.string().trim().min(1).max(128);

export interface NaiveGapScenarioOptions {
  projectionName?: string;
  targetOrderId?: string;
  unrelatedOrderId?: string;
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

function resolveOptions(options: NaiveGapScenarioOptions): Required<NaiveGapScenarioOptions> {
  const resolved = {
    projectionName: ScenarioIdentifierSchema.parse(options.projectionName ?? DefaultProjectionName),
    targetOrderId: ScenarioIdentifierSchema.parse(options.targetOrderId ?? DefaultTargetOrderId),
    unrelatedOrderId: ScenarioIdentifierSchema.parse(
      options.unrelatedOrderId ?? DefaultUnrelatedOrderId,
    ),
  };
  if (resolved.targetOrderId === resolved.unrelatedOrderId) {
    throw new Error("Target and unrelated order IDs must be different");
  }
  return resolved;
}

async function readCustomerOrder(pool: Pool, orderId: string): Promise<OrderProjection> {
  const api = buildOrderApi(pool);
  try {
    const response = await api.inject({ method: "GET", url: `/orders/${orderId}` });
    if (response.statusCode !== 200) {
      throw new Error(`Order API returned HTTP ${String(response.statusCode)}`);
    }
    return OrderProjectionSchema.parse(response.json());
  } finally {
    await api.close();
  }
}

async function replayTargetOrder(
  eventStore: OrderEventStore,
  targetOrderId: string,
): Promise<OrderProjection> {
  const stream = await eventStore.loadStream(targetOrderId);
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

export interface NaiveGapProof {
  customerState: OrderProjection;
  replayedState: OrderProjection;
  paymentPosition: string;
  checkpointPosition: string;
  checkpointStreamId: string;
  laterPollProcessedCount: number;
}

interface FreshDatabaseRow {
  event_count: string;
  stream_count: string;
  view_count: string;
  checkpoint_count: string;
  sequence_value: string;
  sequence_called: boolean;
}

export async function assertFreshNaiveGapDatabase(pool: Pool): Promise<void> {
  const result = await pool.query<FreshDatabaseRow>(
    `SELECT
       (SELECT count(*)::text FROM events) AS event_count,
       (SELECT count(*)::text FROM event_streams) AS stream_count,
       (SELECT count(*)::text FROM order_view) AS view_count,
       (SELECT count(*)::text FROM projection_checkpoints) AS checkpoint_count,
       last_value::text AS sequence_value,
       is_called AS sequence_called
     FROM event_global_position_seq`,
  );
  const state = result.rows[0];
  if (
    state === undefined ||
    state.event_count !== "0" ||
    state.stream_count !== "0" ||
    state.view_count !== "0" ||
    state.checkpoint_count !== "0" ||
    state.sequence_value !== "1" ||
    state.sequence_called
  ) {
    throw new Error("Gap reproduction requires a fresh disposable database; run demo:reset first");
  }
}

export async function waitForCommitGate(
  gateReached: Promise<void>,
  pendingAppend: Promise<unknown>,
  timeoutMs = 2_000,
): Promise<void> {
  await Promise.race([
    gateReached,
    pendingAppend.then(
      () => Promise.reject(new Error("Gated append completed before reaching its commit gate")),
      (error: unknown) => Promise.reject(error),
    ),
    delay(timeoutMs).then(() =>
      Promise.reject(new Error(`Commit gate was not reached within ${String(timeoutMs)}ms`)),
    ),
  ]);
}

export function assertNaiveGapProof(
  proof: NaiveGapProof,
  options: NaiveGapScenarioOptions = {},
): void {
  const resolved = resolveOptions(options);
  const valid =
    proof.customerState.orderId === resolved.targetOrderId &&
    proof.customerState.totalCents === 12_900 &&
    proof.customerState.paidCents === 0 &&
    proof.customerState.paymentStatus === "AWAITING_PAYMENT" &&
    proof.customerState.fulfillmentStatus === "NOT_SHIPPED" &&
    proof.customerState.lastStreamVersion === 1 &&
    proof.replayedState.orderId === resolved.targetOrderId &&
    proof.replayedState.totalCents === 12_900 &&
    proof.replayedState.paidCents === 12_900 &&
    proof.replayedState.paymentStatus === "PAID" &&
    proof.replayedState.fulfillmentStatus === "NOT_SHIPPED" &&
    proof.replayedState.lastStreamVersion === 2 &&
    BigInt(proof.paymentPosition) < BigInt(proof.checkpointPosition) &&
    proof.checkpointStreamId === resolved.unrelatedOrderId &&
    proof.laterPollProcessedCount === 0;
  if (!valid) {
    throw new Error("Expected deterministic naive-projector gap proof is not present");
  }
}

export async function reproduceNaiveGap(
  pool: Pool,
  options: NaiveGapScenarioOptions = {},
): Promise<NaiveGapEvidence> {
  const resolved = resolveOptions(options);
  const eventStore = new OrderEventStore(pool);
  const projector = new NaiveOrderProjector(pool, { projectionName: resolved.projectionName });
  await eventStore.append({
    streamId: resolved.targetOrderId,
    expectedVersion: 0,
    event: { type: "OrderPlaced", totalCents: 12_900 },
  });
  await eventStore.append({
    streamId: resolved.unrelatedOrderId,
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
    streamId: resolved.targetOrderId,
    expectedVersion: 1,
    event: {
      type: "PaymentCaptured",
      paymentId: "PAY-1042",
      amountCents: 12_900,
    },
  });

  try {
    await waitForCommitGate(gateReached.promise, pendingPayment);
    const unrelatedEvent = await eventStore.append({
      streamId: resolved.unrelatedOrderId,
      expectedVersion: 1,
      event: { type: "OrderShipped", shipmentId: "SHIP-2048" },
    });
    const gapPoll = await projector.poll();
    if (gapPoll.processedGlobalPositions.length !== 1) {
      throw new Error("Gap projector poll did not process exactly one visible event");
    }

    releaseCommit.resolve();
    const payment = await pendingPayment;
    const customerState = await readCustomerOrder(pool, resolved.targetOrderId);
    const replayedState = await replayTargetOrder(eventStore, resolved.targetOrderId);
    const laterPoll = await projector.poll();

    const evidence: NaiveGapEvidence = {
      targetOrderId: resolved.targetOrderId,
      pendingPaymentPosition: payment.globalPosition,
      unrelatedCommittedPosition: unrelatedEvent.globalPosition,
      checkpointPosition: gapPoll.checkpointAfter,
      customerState,
      replayedState,
      laterPollProcessedCount: laterPoll.processedCount,
    };
    assertNaiveGapProof(
      {
        customerState,
        replayedState,
        paymentPosition: payment.globalPosition,
        checkpointPosition: gapPoll.checkpointAfter,
        checkpointStreamId: unrelatedEvent.streamId,
        laterPollProcessedCount: laterPoll.processedCount,
      },
      resolved,
    );
    return evidence;
  } finally {
    releaseCommit.resolve();
    await pendingPayment.catch(() => undefined);
  }
}

export async function verifyNaiveGap(
  pool: Pool,
  options: NaiveGapScenarioOptions = {},
): Promise<{
  customerState: OrderProjection;
  replayedState: OrderProjection;
  paymentPosition: string;
  checkpointPosition: string;
  checkpointStreamId: string;
  laterPollProcessedCount: number;
}> {
  const resolved = resolveOptions(options);
  const eventStore = new OrderEventStore(pool);
  const customerState = await readCustomerOrder(pool, resolved.targetOrderId);
  const replayedState = await replayTargetOrder(eventStore, resolved.targetOrderId);
  const stream = await eventStore.loadStream(resolved.targetOrderId);
  const payment = stream.find((event) => event.eventType === "PaymentCaptured");
  if (payment === undefined) {
    throw new Error("Target payment event is missing");
  }
  const checkpointResult = await pool.query<{ last_global_position: string }>(
    `SELECT last_global_position::text
     FROM projection_checkpoints
     WHERE projection_name = $1`,
    [resolved.projectionName],
  );
  const checkpoint = checkpointResult.rows[0];
  if (checkpoint === undefined) {
    throw new Error("Orders checkpoint is missing");
  }
  const checkpointEventResult = await pool.query<{ stream_id: string }>(
    "SELECT stream_id FROM events WHERE global_position = $1::bigint",
    [checkpoint.last_global_position],
  );
  const checkpointEvent = checkpointEventResult.rows[0];
  if (checkpointEvent === undefined) {
    throw new Error("Checkpoint event is missing");
  }
  const laterPoll = await new NaiveOrderProjector(pool, {
    projectionName: resolved.projectionName,
  }).poll();
  const proof: NaiveGapProof = {
    customerState,
    replayedState,
    paymentPosition: payment.globalPosition,
    checkpointPosition: checkpoint.last_global_position,
    checkpointStreamId: checkpointEvent.stream_id,
    laterPollProcessedCount: laterPoll.processedCount,
  };
  assertNaiveGapProof(proof, resolved);

  return {
    customerState,
    replayedState,
    paymentPosition: payment.globalPosition,
    checkpointPosition: checkpoint.last_global_position,
    checkpointStreamId: checkpointEvent.stream_id,
    laterPollProcessedCount: laterPoll.processedCount,
  };
}
