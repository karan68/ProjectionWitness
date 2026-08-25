import { OrderIdSchema, OrderProjectionSchema } from "@projection-witness/domain";
import { z } from "zod";
import { canonicalJsonBytes, canonicalSha256 } from "./canonical-json.js";
import {
  CanonicalOrderEventSchema,
  CanonicalProjectionValueSchema,
  CurrentProjectionRowSchema,
  RuntimeEvidenceSchema,
  type CanonicalOrderEvent,
  type CanonicalProjectionValue,
  type CurrentProjectionRow,
  type RuntimeEvidence,
} from "./schemas.js";

const NonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const PositiveIntegerSchema = z.number().int().positive().safe();

export interface EvidenceFingerprint<Value> {
  value: Value;
  sha256: string;
}

export interface EventStreamEvidence {
  streamId: string;
  headVersion: number;
  eventCount: number;
  firstStreamVersion: number | null;
  lastStreamVersion: number | null;
  sha256: string;
  canonicalBytes: number;
}

export interface EventStreamSnapshot {
  events: readonly CanonicalOrderEvent[];
  evidence: EventStreamEvidence;
}

export interface SnapshotEventStreamInput {
  streamId: string;
  headVersion: number;
  events: readonly unknown[];
  maxEvents?: number;
  maxCanonicalBytes?: number;
}

export function snapshotEventStream(input: SnapshotEventStreamInput): EventStreamSnapshot {
  const streamId = OrderIdSchema.parse(input.streamId);
  const headVersion = NonNegativeIntegerSchema.parse(input.headVersion);
  const maxEvents = PositiveIntegerSchema.parse(input.maxEvents ?? 1_000);
  const maxCanonicalBytes = PositiveIntegerSchema.parse(input.maxCanonicalBytes ?? 1_048_576);
  const events = z.array(CanonicalOrderEventSchema).max(maxEvents).parse(input.events);
  const eventIds = new Set<string>();
  const globalPositions = new Set<string>();

  for (const [index, event] of events.entries()) {
    if (event.streamId !== streamId) {
      throw new Error("Event stream ID does not match the requested stream");
    }
    if (event.streamVersion !== index + 1) {
      throw new Error("Event stream versions are not contiguous and ordered from one");
    }
    if (eventIds.has(event.eventId)) {
      throw new Error("Event stream contains a duplicate event ID");
    }
    if (globalPositions.has(event.globalPosition)) {
      throw new Error("Event stream contains a duplicate global position");
    }
    eventIds.add(event.eventId);
    globalPositions.add(event.globalPosition);
  }
  if (events.length !== headVersion) {
    throw new Error("Event count does not match the locked stream head version");
  }

  const canonicalEvents = canonicalJsonBytes(events);
  if (canonicalEvents.byteLength > maxCanonicalBytes) {
    throw new Error("Canonical event stream exceeds the configured byte limit");
  }

  return {
    events,
    evidence: {
      streamId,
      headVersion,
      eventCount: events.length,
      firstStreamVersion: events[0]?.streamVersion ?? null,
      lastStreamVersion: events.at(-1)?.streamVersion ?? null,
      sha256: canonicalSha256(events),
      canonicalBytes: canonicalEvents.byteLength,
    },
  };
}

export function fingerprintCurrentProjectionRow(
  input: unknown,
): EvidenceFingerprint<CurrentProjectionRow> {
  const value = CurrentProjectionRowSchema.parse(input);
  return { value, sha256: canonicalSha256(value) };
}

export function canonicalProjectionValue(input: unknown): CanonicalProjectionValue {
  const projection = OrderProjectionSchema.parse(input);
  return CanonicalProjectionValueSchema.parse({
    orderId: projection.orderId,
    totalCents: String(projection.totalCents),
    paidCents: String(projection.paidCents),
    paymentStatus: projection.paymentStatus,
    fulfillmentStatus: projection.fulfillmentStatus,
    lastStreamVersion: projection.lastStreamVersion,
  });
}

export function fingerprintCandidateProjection(
  input: unknown,
): EvidenceFingerprint<CanonicalProjectionValue> {
  const value = CanonicalProjectionValueSchema.parse(input);
  return { value, sha256: canonicalSha256(value) };
}

export function fingerprintRuntime(input: unknown): EvidenceFingerprint<RuntimeEvidence> {
  const value = RuntimeEvidenceSchema.parse(input);
  return { value, sha256: canonicalSha256(value) };
}
