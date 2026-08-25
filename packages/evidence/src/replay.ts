import {
  OrderEventSchema,
  OrderProjectionSchema,
  type OrderEvent,
  type OrderProjection,
} from "@projection-witness/domain";
import { reduceOrder } from "@projection-witness/reducer";
import { canonicalJson, canonicalSha256 } from "./canonical-json.js";
import { canonicalProjectionValue, type EvidenceFingerprint } from "./fingerprints.js";
import {
  CanonicalOrderEventSchema,
  type CanonicalOrderEvent,
  type CanonicalProjectionValue,
} from "./schemas.js";

export type EvidenceOrderReducer = (
  state: OrderProjection | null,
  event: OrderEvent,
) => OrderProjection;

export interface DeterministicReplayEvidence {
  candidate: EvidenceFingerprint<CanonicalProjectionValue>;
  deterministic: true;
}

function replayOnce(
  eventsInput: readonly unknown[],
  reducer: EvidenceOrderReducer,
): OrderProjection {
  const events = eventsInput.map((input) => CanonicalOrderEventSchema.parse(input));
  const result = events.reduce<OrderProjection | null>((state, storedEvent) => {
    const event = OrderEventSchema.parse({
      streamId: storedEvent.streamId,
      streamVersion: storedEvent.streamVersion,
      ...storedEvent.payload,
    });
    return OrderProjectionSchema.parse(reducer(state, event));
  }, null);
  if (result === null) {
    throw new Error("Cannot derive a candidate from an empty event stream");
  }
  return result;
}

export function replayOrderStreamDeterministically(
  events: readonly CanonicalOrderEvent[],
  reducer: EvidenceOrderReducer = reduceOrder,
): DeterministicReplayEvidence {
  const first = canonicalProjectionValue(replayOnce(events, reducer));
  const second = canonicalProjectionValue(replayOnce(events, reducer));
  if (canonicalJson(first) !== canonicalJson(second)) {
    throw new Error("Reducer output is not deterministic");
  }
  return {
    candidate: { value: first, sha256: canonicalSha256(first) },
    deterministic: true,
  };
}
