import { versionOrderEvent } from "@projection-witness/domain";
import { reduceOrder } from "@projection-witness/reducer";
import { describe, expect, it } from "vitest";

describe("reduceOrder", () => {
  it("derives payment and fulfillment state from a contiguous stream", () => {
    const placed = versionOrderEvent("ORD-1042", 1, {
      type: "OrderPlaced",
      totalCents: 12_900,
    });
    const partialPayment = versionOrderEvent("ORD-1042", 2, {
      type: "PaymentCaptured",
      paymentId: "PAY-1",
      amountCents: 2_900,
    });
    const finalPayment = versionOrderEvent("ORD-1042", 3, {
      type: "PaymentCaptured",
      paymentId: "PAY-2",
      amountCents: 10_000,
    });
    const shipped = versionOrderEvent("ORD-1042", 4, {
      type: "OrderShipped",
      shipmentId: "SHIP-1",
    });

    const afterPlaced = reduceOrder(null, placed);
    expect(afterPlaced).toEqual({
      orderId: "ORD-1042",
      totalCents: 12_900,
      paidCents: 0,
      paymentStatus: "AWAITING_PAYMENT",
      fulfillmentStatus: "NOT_SHIPPED",
      lastStreamVersion: 1,
    });

    const afterPartialPayment = reduceOrder(afterPlaced, partialPayment);
    expect(afterPartialPayment.paymentStatus).toBe("PARTIALLY_PAID");

    const afterFinalPayment = reduceOrder(afterPartialPayment, finalPayment);
    expect(afterFinalPayment.paymentStatus).toBe("PAID");

    const afterShipment = reduceOrder(afterFinalPayment, shipped);
    expect(afterShipment.fulfillmentStatus).toBe("SHIPPED");
    expect(afterShipment.lastStreamVersion).toBe(4);
  });

  it("treats a zero-total order as paid", () => {
    const state = reduceOrder(
      null,
      versionOrderEvent("ORD-FREE", 1, { type: "OrderPlaced", totalCents: 0 }),
    );

    expect(state.paymentStatus).toBe("PAID");
  });

  it("represents overpayment as paid without inventing a rejection rule", () => {
    const placed = reduceOrder(
      null,
      versionOrderEvent("ORD-OVERPAID", 1, { type: "OrderPlaced", totalCents: 100 }),
    );
    const paid = reduceOrder(
      placed,
      versionOrderEvent("ORD-OVERPAID", 2, {
        type: "PaymentCaptured",
        paymentId: "PAY-OVER",
        amountCents: 101,
      }),
    );

    expect(paid.paidCents).toBe(101);
    expect(paid.paymentStatus).toBe("PAID");
  });

  it("rejects invalid money and unknown event fields at runtime", () => {
    expect(() =>
      versionOrderEvent("ORD-1042", 1, {
        type: "OrderPlaced",
        totalCents: -1,
      }),
    ).toThrow();

    expect(() =>
      versionOrderEvent("ORD-1042", 1, {
        type: "OrderPlaced",
        totalCents: 100,
        extra: "not allowed",
      } as never),
    ).toThrow();
  });

  it("rejects invalid stream starts, gaps, and cross-stream events", () => {
    const placed = versionOrderEvent("ORD-1042", 1, {
      type: "OrderPlaced",
      totalCents: 100,
    });
    const state = reduceOrder(null, placed);

    expect(() =>
      reduceOrder(
        null,
        versionOrderEvent("ORD-1042", 2, {
          type: "PaymentCaptured",
          paymentId: "PAY-1",
          amountCents: 100,
        }),
      ),
    ).toThrow(/begin with OrderPlaced/);

    expect(() =>
      reduceOrder(
        state,
        versionOrderEvent("ORD-1042", 3, {
          type: "OrderShipped",
          shipmentId: "SHIP-1",
        }),
      ),
    ).toThrow(/not contiguous/);

    expect(() =>
      reduceOrder(
        state,
        versionOrderEvent("ORD-OTHER", 2, {
          type: "OrderShipped",
          shipmentId: "SHIP-1",
        }),
      ),
    ).toThrow(/does not match/);
  });

  it("does not mutate the previous projection", () => {
    const previous = reduceOrder(
      null,
      versionOrderEvent("ORD-1042", 1, { type: "OrderPlaced", totalCents: 100 }),
    );
    const snapshot = structuredClone(previous);

    reduceOrder(
      previous,
      versionOrderEvent("ORD-1042", 2, {
        type: "PaymentCaptured",
        paymentId: "PAY-1",
        amountCents: 100,
      }),
    );

    expect(previous).toEqual(snapshot);
  });
});
