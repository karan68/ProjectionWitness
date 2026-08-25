import {
  OrderEventSchema,
  OrderProjectionSchema,
  type OrderEvent,
  type OrderProjection,
  type PaymentStatus,
} from "@projection-witness/domain";

function paymentStatus(totalCents: number, paidCents: number): PaymentStatus {
  if (paidCents === 0 && totalCents > 0) {
    return "AWAITING_PAYMENT";
  }
  if (paidCents < totalCents) {
    return "PARTIALLY_PAID";
  }
  return "PAID";
}

export function reduceOrder(
  previous: OrderProjection | null,
  unvalidatedEvent: OrderEvent,
): OrderProjection {
  const event = OrderEventSchema.parse(unvalidatedEvent);
  const state = previous === null ? null : OrderProjectionSchema.parse(previous);

  if (state === null) {
    if (event.type !== "OrderPlaced" || event.streamVersion !== 1) {
      throw new Error("An order stream must begin with OrderPlaced at stream version 1");
    }

    return {
      orderId: event.streamId,
      totalCents: event.totalCents,
      paidCents: 0,
      paymentStatus: paymentStatus(event.totalCents, 0),
      fulfillmentStatus: "NOT_SHIPPED",
      lastStreamVersion: 1,
    };
  }

  if (event.streamId !== state.orderId) {
    throw new Error("Event stream does not match the projection order");
  }
  if (event.streamVersion !== state.lastStreamVersion + 1) {
    throw new Error("Event stream version is not contiguous");
  }
  if (event.type === "OrderPlaced") {
    throw new Error("OrderPlaced may appear only once at the start of an order stream");
  }

  if (event.type === "PaymentCaptured") {
    const paidCents = state.paidCents + event.amountCents;
    if (!Number.isSafeInteger(paidCents)) {
      throw new Error("Accumulated paid cents exceed the safe integer range");
    }
    return {
      ...state,
      paidCents,
      paymentStatus: paymentStatus(state.totalCents, paidCents),
      lastStreamVersion: event.streamVersion,
    };
  }

  return {
    ...state,
    fulfillmentStatus: "SHIPPED",
    lastStreamVersion: event.streamVersion,
  };
}
