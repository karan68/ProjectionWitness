import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { ApprovedOrderReducerSha256 } from "@projection-witness/projector";
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
const MaximumReducerArtifactBytes = 1_048_576;
const verifiedEvidence = new WeakSet<object>();
const WorkerResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("result"), first: z.unknown(), second: z.unknown() }).strict(),
  z.object({ type: z.literal("error") }).strict(),
]);

const ReducerWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { createContext, Script } = require("node:vm");
const parseJson = JSON.parse.bind(JSON);
const serializedEvents = JSON.stringify(workerData.events);

async function main() {
  const loadReducer = (replayPass) => {
    const reducerModule = { exports: {} };
    const context = createContext({
      __projectionWitnessReplayPass: replayPass,
      module: reducerModule,
      exports: reducerModule.exports,
    });
    new Script(workerData.artifactSource, {
      filename: "projection-witness-order-reducer.cjs",
    }).runInContext(context);
    if (typeof reducerModule.exports.reduceOrder !== "function") {
      throw new Error("Reducer artifact must export reduceOrder");
    }
    return reducerModule.exports.reduceOrder;
  }
  const replay = async (replayPass) => {
    const reduceOrder = loadReducer(replayPass);
    const events = parseJson(serializedEvents);
    let state = null;
    for (const storedEvent of events) {
      state = await reduceOrder(state, {
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
  parentPort.postMessage({ type: "result", first: await replay(1), second: await replay(2) });
}

main().catch(() => parentPort.postMessage({ type: "error" }));
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

export function parseReducerWorkerMessage(
  message: unknown,
): { type: "result"; first: unknown; second: unknown } | { type: "error" } {
  const parsed = WorkerResultSchema.safeParse(message);
  if (!parsed.success) {
    throw new Error("Reducer worker returned malformed evidence");
  }
  return parsed.data;
}

export async function executeReducerBytes(
  artifactBytes: Buffer,
  events: readonly unknown[],
  maxExecutionMs: number,
): Promise<{ first: unknown; second: unknown }> {
  const worker = new Worker(ReducerWorkerSource, {
    env: {},
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    workerData: { artifactSource: artifactBytes.toString("utf8"), events },
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
      let parsed: ReturnType<typeof parseReducerWorkerMessage>;
      try {
        parsed = parseReducerWorkerMessage(message);
      } catch (error) {
        finish(() => rejectPromise(error));
        return;
      }
      finish(() => {
        void worker.terminate();
        if (parsed.type === "error") {
          rejectPromise(new Error("Reducer worker failed"));
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
  if (parsed.expectedReducerSha256 !== ApprovedOrderReducerSha256) {
    throw new Error("Reducer artifact digest is not approved by this build");
  }
  const artifactPath = resolve(artifactPathInput);
  const artifactFile = await open(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let artifactBytes: Buffer;
  try {
    const artifactStats = await artifactFile.stat();
    if (!artifactStats.isFile() || artifactStats.size > MaximumReducerArtifactBytes) {
      throw new Error("Reducer artifact must be a file no larger than 1048576 bytes");
    }
    artifactBytes = await artifactFile.readFile();
    if (artifactBytes.byteLength > MaximumReducerArtifactBytes) {
      throw new Error("Reducer artifact must be a file no larger than 1048576 bytes");
    }
  } finally {
    await artifactFile.close();
  }
  const reducerSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  if (reducerSha256 !== parsed.expectedReducerSha256) {
    throw new Error("Reducer artifact digest does not match runtime attestation");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(artifactBytes);
  } catch {
    throw new Error("Reducer artifact is not valid UTF-8 JavaScript");
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
