import {
  assertNaiveGapProof,
  waitForCommitGate,
  type NaiveGapProof,
} from "@projection-witness/demo-driver";
import { describe, expect, it } from "vitest";

const ValidProof: NaiveGapProof = {
  customerState: {
    orderId: "ORD-1042",
    totalCents: 12_900,
    paidCents: 0,
    paymentStatus: "AWAITING_PAYMENT",
    fulfillmentStatus: "NOT_SHIPPED",
    lastStreamVersion: 1,
  },
  replayedState: {
    orderId: "ORD-1042",
    totalCents: 12_900,
    paidCents: 12_900,
    paymentStatus: "PAID",
    fulfillmentStatus: "NOT_SHIPPED",
    lastStreamVersion: 2,
  },
  paymentPosition: "3",
  checkpointPosition: "4",
  checkpointStreamId: "ORD-2048",
  laterPollProcessedCount: 0,
};

describe("naive gap coordination", () => {
  it("propagates an append failure before the commit gate is reached", async () => {
    const gateNeverReached = new Promise<void>(() => undefined);
    const appendFailure = Promise.reject(new Error("append failed before gate"));

    await expect(waitForCommitGate(gateNeverReached, appendFailure, 1_000)).rejects.toThrow(
      /append failed before gate/,
    );
  });

  it("accepts the complete deterministic proof", () => {
    expect(() => assertNaiveGapProof(ValidProof)).not.toThrow();
  });

  it.each([
    ["customer paid amount", { customerState: { ...ValidProof.customerState, paidCents: 1 } }],
    [
      "customer stream version",
      { customerState: { ...ValidProof.customerState, lastStreamVersion: 2 } },
    ],
    ["replayed paid amount", { replayedState: { ...ValidProof.replayedState, paidCents: 12_899 } }],
    [
      "replayed stream version",
      { replayedState: { ...ValidProof.replayedState, lastStreamVersion: 1 } },
    ],
    ["checkpoint ordering", { paymentPosition: "4", checkpointPosition: "3" }],
    ["checkpoint stream", { checkpointStreamId: "ORD-1042" }],
    ["later poll", { laterPollProcessedCount: 1 }],
  ])("rejects a proof with the wrong %s", (_name, patch) => {
    const invalid = {
      ...ValidProof,
      ...patch,
    } as NaiveGapProof;

    expect(() => assertNaiveGapProof(invalid)).toThrow(/proof is not present/);
  });
});
