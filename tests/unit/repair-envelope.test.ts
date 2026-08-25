import {
  buildRepairEnvelope,
  runReducerArtifactEvidence,
  verifyRepairEnvelope,
  type CanonicalOrderEvent,
  type VerifiedReducerArtifactEvidence,
} from "@projection-witness/evidence";
import { buildReducerBundle } from "../../scripts/lib/reducer-bundle.js";
import { beforeAll, describe, expect, it } from "vitest";

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

let reducerEvidence: VerifiedReducerArtifactEvidence;

beforeAll(async () => {
  const bundle = await buildReducerBundle();
  reducerEvidence = await runReducerArtifactEvidence(bundle.outputPath, {
    schemaVersion: 1,
    expectedReducerSha256: bundle.sha256,
    streamId: "ORD-1042",
    headVersion: 2,
    events,
  });
});

function validEnvelope() {
  const runtime = {
    projectionName: "orders",
    generation: "2",
    reducerSha256: reducerEvidence.reducerSha256,
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
    runtime,
    currentRow,
    reducerEvidence,
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

  it("refuses forged evidence and runtime digests unrelated to executed bytes", () => {
    const envelope = validEnvelope();
    const base = {
      planId: envelope.planId,
      projectionName: envelope.projectionName,
      runtime: envelope.runtime,
      currentRow: {
        ...envelope.currentRow.value,
        rowVersion: envelope.currentRow.rowVersion,
      },
      clock: () => new Date("2026-08-26T01:00:00.000Z"),
    };
    expect(() =>
      buildRepairEnvelope({
        ...base,
        reducerEvidence: structuredClone(reducerEvidence),
      } as Parameters<typeof buildRepairEnvelope>[0]),
    ).toThrow(/requires verified reducer artifact evidence/);
    expect(() =>
      buildRepairEnvelope({
        ...base,
        runtime: { ...base.runtime, reducerSha256: "b".repeat(64) },
        reducerEvidence,
      }),
    ).toThrow(/does not match runtime attestation/);
  });

  it("has a stable project-specific evidence digest", () => {
    expect(validEnvelope().evidenceSha256).toBe(
      "c45752e3a38ef7656eb121e5aa5b1aff5412b5645ed91408ea0a07df6c1366c7",
    );
  });
});
