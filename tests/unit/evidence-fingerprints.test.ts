import {
  canonicalProjectionValue,
  fingerprintCurrentProjectionRow,
  fingerprintRuntime,
  replayOrderStreamDeterministically,
  snapshotEventStream,
  type CanonicalOrderEvent,
} from "@projection-witness/evidence";
import { describe, expect, it } from "vitest";

const events: readonly CanonicalOrderEvent[] = [
  {
    eventId: "10000000-0000-4000-8000-000000000001",
    globalPosition: "9007199254740993",
    streamId: "ORD-1042",
    streamVersion: 1,
    eventType: "OrderPlaced",
    payload: { type: "OrderPlaced", totalCents: 12_900 },
    metadata: { source: "checkout" },
    recordedAt: "2026-08-26T00:00:00.000Z",
  },
  {
    eventId: "10000000-0000-4000-8000-000000000002",
    globalPosition: "9007199254740995",
    streamId: "ORD-1042",
    streamVersion: 2,
    eventType: "PaymentCaptured",
    payload: { type: "PaymentCaptured", paymentId: "PAY-1042", amountCents: 12_900 },
    metadata: {},
    recordedAt: "2026-08-26T00:00:01.000Z",
  },
];

describe("evidence fingerprints", () => {
  it("fingerprints an ordered stream without requiring contiguous global positions", () => {
    const snapshot = snapshotEventStream({
      streamId: "ORD-1042",
      headVersion: 2,
      events,
    });

    expect(snapshot.evidence).toMatchObject({
      streamId: "ORD-1042",
      headVersion: 2,
      eventCount: 2,
      firstStreamVersion: 1,
      lastStreamVersion: 2,
    });
    expect(snapshot.evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.evidence.canonicalBytes).toBeGreaterThan(0);
  });

  it("rejects stream mismatch, version gaps, head mismatch, and byte overflow", () => {
    expect(() =>
      snapshotEventStream({
        streamId: "OTHER",
        headVersion: 2,
        events,
      }),
    ).toThrow(/stream ID/);
    expect(() =>
      snapshotEventStream({
        streamId: "ORD-1042",
        headVersion: 2,
        events: [{ ...events[0], streamVersion: 2 }, events[1]],
      }),
    ).toThrow(/not contiguous/);
    expect(() => snapshotEventStream({ streamId: "ORD-1042", headVersion: 1, events })).toThrow(
      /locked stream head/,
    );
    expect(() =>
      snapshotEventStream({
        streamId: "ORD-1042",
        headVersion: 2,
        events,
        maxCanonicalBytes: 1,
      }),
    ).toThrow(/byte limit/);
  });

  it("excludes volatile row timestamps and rejects numeric bigint fields", () => {
    const row = {
      orderId: "ORD-1042",
      totalCents: "12900",
      paidCents: "0",
      paymentStatus: "AWAITING_PAYMENT",
      fulfillmentStatus: "NOT_SHIPPED",
      lastStreamVersion: 1,
      rowVersion: "7",
    } as const;
    expect(fingerprintCurrentProjectionRow(row).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => fingerprintCurrentProjectionRow({ ...row, updatedAt: "volatile" })).toThrow();
    expect(() => fingerprintCurrentProjectionRow({ ...row, paidCents: 0 })).toThrow();
  });

  it("fingerprints runtime without registration time", () => {
    const runtime = {
      projectionName: "orders",
      generation: "2",
      reducerSha256: "a".repeat(64),
      sourceCommitSha: "0123456789abcdef",
      algorithmVersion: "gap-aware-v1",
      gapStrategy: "TRACKED_NON_BLOCKING",
    };
    expect(fingerprintRuntime(runtime).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => fingerprintRuntime({ ...runtime, registeredAt: "volatile" })).toThrow();
  });

  it("runs the reducer twice and fingerprints canonical candidate values", () => {
    const replay = replayOrderStreamDeterministically(events);
    expect(replay.deterministic).toBe(true);
    expect(replay.candidate.value).toEqual({
      orderId: "ORD-1042",
      totalCents: "12900",
      paidCents: "12900",
      paymentStatus: "PAID",
      fulfillmentStatus: "NOT_SHIPPED",
      lastStreamVersion: 2,
    });
    expect(replay.candidate.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      canonicalProjectionValue({
        orderId: "ORD-1042",
        totalCents: 12_900,
        paidCents: 12_900,
        paymentStatus: "PAID",
        fulfillmentStatus: "NOT_SHIPPED",
        lastStreamVersion: 2,
      }),
    ).toEqual(replay.candidate.value);
  });

  it("rejects a reducer that changes output between runs", () => {
    let invocation = 0;
    expect(() =>
      replayOrderStreamDeterministically(events, (state, event) => {
        invocation += 1;
        const base = state ?? {
          orderId: event.streamId,
          totalCents: 12_900,
          paidCents: 0,
          paymentStatus: "AWAITING_PAYMENT" as const,
          fulfillmentStatus: "NOT_SHIPPED" as const,
          lastStreamVersion: 1,
        };
        return {
          ...base,
          paidCents: invocation,
          lastStreamVersion: event.streamVersion,
        };
      }),
    ).toThrow(/not deterministic/);
  });
});
