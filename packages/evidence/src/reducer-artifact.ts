import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import {
  canonicalProjectionValue,
  fingerprintCandidateProjection,
  snapshotEventStream,
  type EventStreamEvidence,
  type EvidenceFingerprint,
} from "./fingerprints.js";
import {
  CanonicalProjectionValueSchema,
  Sha256Schema,
  type CanonicalProjectionValue,
} from "./schemas.js";

export const ReducerArtifactEvidenceInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedReducerSha256: Sha256Schema,
    streamId: z.string().trim().min(1).max(128),
    headVersion: z.number().int().nonnegative().safe(),
    events: z.array(z.unknown()),
  })
  .strict();

export type ReducerArtifactEvidenceInput = z.infer<typeof ReducerArtifactEvidenceInputSchema>;

const EventStreamEvidenceSchema = z
  .object({
    streamId: z.string().trim().min(1).max(128),
    headVersion: z.number().int().nonnegative().safe(),
    eventCount: z.number().int().nonnegative().safe(),
    firstStreamVersion: z.number().int().positive().safe().nullable(),
    lastStreamVersion: z.number().int().positive().safe().nullable(),
    sha256: Sha256Schema,
    canonicalBytes: z.number().int().nonnegative().safe(),
  })
  .strict();

const CandidateEvidenceSchema = z
  .object({
    value: CanonicalProjectionValueSchema,
    sha256: Sha256Schema,
  })
  .strict();

export const ReducerArtifactEvidenceResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    reducerSha256: Sha256Schema,
    stream: EventStreamEvidenceSchema,
    candidate: CandidateEvidenceSchema,
    reducerDeterministic: z.literal(true),
  })
  .strict();

export interface ReducerArtifactEvidenceResult {
  schemaVersion: 1;
  reducerSha256: string;
  stream: EventStreamEvidence;
  candidate: EvidenceFingerprint<CanonicalProjectionValue>;
  reducerDeterministic: true;
}

declare const VerifiedReducerArtifactEvidenceBrand: unique symbol;
export type VerifiedReducerArtifactEvidence = ReducerArtifactEvidenceResult & {
  readonly [VerifiedReducerArtifactEvidenceBrand]: true;
};

export interface ReducerArtifactEvidenceLimits {
  maxEvents?: number;
  maxCanonicalBytes?: number;
  maxExecutionMs?: number;
}

const ExecutionTimeoutSchema = z.number().int().positive().safe().max(60_000);
const verifiedEvidence = new WeakSet<object>();
const WorkerResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("result"), first: z.unknown(), second: z.unknown() }).strict(),
  z.object({ type: z.literal("error"), message: z.string() }).strict(),
]);

const ReducerWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const parseJson = JSON.parse.bind(JSON);
const serializedEvents = JSON.stringify(workerData.events);

async function main() {
  const reducerModule = await import(workerData.artifactDataUrl);
  if (typeof reducerModule.reduceOrder !== "function") {
    throw new Error("Reducer artifact must export reduceOrder");
  }
  const replay = () => {
    const events = parseJson(serializedEvents);
    let state = null;
    for (const storedEvent of events) {
      state = reducerModule.reduceOrder(state, {
        streamId: storedEvent.streamId,
        streamVersion: storedEvent.streamVersion,
        ...storedEvent.payload,
      });
    }
    if (state === null) {
      throw new Error("Cannot derive a candidate from an empty event stream");
    }
    return state;
  };
  parentPort.postMessage({ type: "result", first: replay(), second: replay() });
}

main().catch((error) => {
  parentPort.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : "Reducer worker failed",
  });
});
`;

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  Object.freeze(value);
}

function markVerified(result: ReducerArtifactEvidenceResult): VerifiedReducerArtifactEvidence {
  const parsed = ReducerArtifactEvidenceResultSchema.parse(result);
  deepFreeze(parsed);
  verifiedEvidence.add(parsed);
  return parsed as VerifiedReducerArtifactEvidence;
}

export function isVerifiedReducerArtifactEvidence(
  value: unknown,
): value is VerifiedReducerArtifactEvidence {
  return typeof value === "object" && value !== null && verifiedEvidence.has(value);
}

async function executeReducerBytes(
  artifactBytes: Buffer,
  events: readonly unknown[],
  maxExecutionMs: number,
): Promise<{ first: unknown; second: unknown }> {
  const artifactDataUrl = `data:text/javascript;base64,${artifactBytes.toString("base64")}`;
  const worker = new Worker(ReducerWorkerSource, {
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    workerData: { artifactDataUrl, events },
  });

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      finish(() => {
        void worker.terminate();
        rejectPromise(new Error("Reducer execution exceeded the configured deadline"));
      });
    }, maxExecutionMs);

    worker.once("message", (message: unknown) => {
      finish(() => {
        void worker.terminate();
        const parsed = WorkerResultSchema.parse(message);
        if (parsed.type === "error") {
          rejectPromise(new Error(parsed.message));
          return;
        }
        resolvePromise({ first: parsed.first, second: parsed.second });
      });
    });
    worker.once("error", (error) => finish(() => rejectPromise(error)));
    worker.once("exit", (code) => {
      finish(() =>
        rejectPromise(
          new Error(
            code === 0
              ? "Reducer worker exited without returning evidence"
              : `Reducer worker exited with code ${String(code)}`,
          ),
        ),
      );
    });
  });
}

export async function sha256File(pathInput: string): Promise<string> {
  const bytes = await readFile(resolve(pathInput));
  return createHash("sha256").update(bytes).digest("hex");
}

export async function runReducerArtifactEvidence(
  artifactPathInput: string,
  input: unknown,
  limits: ReducerArtifactEvidenceLimits = {},
): Promise<VerifiedReducerArtifactEvidence> {
  const parsed = ReducerArtifactEvidenceInputSchema.parse(input);
  const artifactPath = resolve(artifactPathInput);
  const artifactBytes = await readFile(artifactPath);
  const reducerSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  if (reducerSha256 !== parsed.expectedReducerSha256) {
    throw new Error("Reducer artifact digest does not match runtime attestation");
  }

  const snapshot = snapshotEventStream({
    streamId: parsed.streamId,
    headVersion: parsed.headVersion,
    events: parsed.events,
    ...(limits.maxEvents === undefined ? {} : { maxEvents: limits.maxEvents }),
    ...(limits.maxCanonicalBytes === undefined
      ? {}
      : { maxCanonicalBytes: limits.maxCanonicalBytes }),
  });
  const replay = await executeReducerBytes(
    artifactBytes,
    snapshot.events,
    ExecutionTimeoutSchema.parse(limits.maxExecutionMs ?? 2_000),
  );
  const first = canonicalProjectionValue(replay.first);
  const second = canonicalProjectionValue(replay.second);
  if (canonicalJson(first) !== canonicalJson(second)) {
    throw new Error("Reducer output is not deterministic");
  }
  return markVerified({
    schemaVersion: 1,
    reducerSha256,
    stream: snapshot.evidence,
    candidate: fingerprintCandidateProjection(first),
    reducerDeterministic: true,
  });
}
