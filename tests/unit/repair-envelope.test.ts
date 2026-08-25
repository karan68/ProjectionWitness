import {
  buildRepairEnvelope,
  verifyRepairEnvelope,
  type CanonicalOrderEvent,
} from "@projection-witness/evidence";
import { reduceOrder } from "@projection-witness/reducer";
import { describe, expect, it } from "vitest";

const events: readonly CanonicalOrderEvent[] = [
  {
    eventId: "20000000-0000-4000-8000-000000000001",
    globalPosition: "41",
    streamId: "ORD-1042",
    streamVersion: 1,
    eventType: "OrderPlaced",
    payload: { type: "OrderPlaced", totalCents: 12_900 },
    metadata: {},
    recordedAt: "2026-08-26T00:00:00.000Z",
  },
  {
    eventId: "20000000-0000-4000-8000-000000000002",
    globalPosition: "43",
    streamId: "ORD-1042",
    streamVersion: 2,
    eventType: "PaymentCaptured",
    payload: { type: "PaymentCaptured", paymentId: "PAY-1042", amountCents: 12_900 },
    metadata: {},
    recordedAt: "2026-08-26T00:00:01.000Z",
  },
];

function validEnvelope() {
  const runtime = {
    projectionName: "orders",
    generation: "2",
    reducerSha256: "a".repeat(64),
    sourceCommitSha: "0123456789abcdef",
    algorithmVersion: "gap-aware-v1",
    gapStrategy: "TRACKED_NON_BLOCKING",
  };
  const currentRow = {
    orderId: "ORD-1042",
    totalCents: "12900",
    paidCents: "0",
    paymentStatus: "AWAITING_PAYMENT",
    fulfillmentStatus: "NOT_SHIPPED",
    lastStreamVersion: 1,
    rowVersion: "7",
  };
  return buildRepairEnvelope({
    planId: "30000000-0000-4000-8000-000000000001",
    projectionName: "orders",
    streamId: "ORD-1042",
    headVersion: 2,
    events,
    runtime,
    currentRow,
    reducer: reduceOrder,
    clock: () => new Date("2026-08-26T01:00:00.000Z"),
    ttlSeconds: 300,
  });
}

describe("repair evidence envelope", () => {
  it("seals and verifies the exact evidence with injected time", () => {
    const envelope = validEnvelope();

    expect(envelope.createdAt).toBe("2026-08-26T01:00:00.000Z");
    expect(envelope.expiresAt).toBe("2026-08-26T01:05:00.000Z");
    expect(envelope.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyRepairEnvelope(envelope)).toEqual(envelope);
  });

  it("detects current-row, candidate, and envelope tampering", () => {
    const envelope = validEnvelope();
    expect(() =>
      verifyRepairEnvelope({
        ...envelope,
        currentRow: {
          ...envelope.currentRow,
          value: { ...envelope.currentRow.value, paidCents: "1" },
        },
      }),
    ).toThrow(/Current projection row fingerprint/);
    expect(() =>
      verifyRepairEnvelope({
        ...envelope,
        candidateRow: {
          ...envelope.candidateRow,
          value: { ...envelope.candidateRow.value, paidCents: "1" },
        },
      }),
    ).toThrow(/Candidate projection fingerprint/);
    expect(() =>
      verifyRepairEnvelope({ ...envelope, expiresAt: "2026-08-26T01:06:00.000Z" }),
    ).toThrow(/evidence fingerprint/);
  });

  it("refuses missing, duplicate, or failed invariants during verification", () => {
    const envelope = validEnvelope();
    expect(() =>
      verifyRepairEnvelope({
        ...envelope,
        invariants: envelope.invariants.slice(0, 3),
      }),
    ).toThrow();
    expect(() =>
      verifyRepairEnvelope({
        ...envelope,
        invariants: [
          envelope.invariants[0],
          envelope.invariants[0],
          envelope.invariants[2],
          envelope.invariants[3],
        ],
      }),
    ).toThrow(/unique/);
    expect(() =>
      verifyRepairEnvelope({
        ...envelope,
        invariants: envelope.invariants.map((invariant) =>
          invariant.id === "reducer_deterministic" ? { ...invariant, passed: false } : invariant,
        ),
      }),
    ).toThrow(/must pass/);
  });

  it("derives invariants and refuses cross-field or unsafe-runtime evidence", () => {
    const envelope = validEnvelope();
    expect(envelope.invariants.every((invariant) => invariant.passed)).toBe(true);
    expect(() =>
      verifyRepairEnvelope({
        ...envelope,
        runtime: { ...envelope.runtime, gapStrategy: "UNKNOWN" },
      }),
    ).toThrow(/Root projector fix/);
    expect(() =>
      verifyRepairEnvelope({
        ...envelope,
        stream: { ...envelope.stream, streamId: "OTHER" },
      }),
    ).toThrow(/IDs do not match/);
  });

  it("has a stable project-specific evidence digest", () => {
    expect(validEnvelope().evidenceSha256).toBe(
      "a3ec99f2204725612fb753e6ab2e66ef3b7cb3499818cd3cf4a3057a0f33fe95",
    );
  });
});
