import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { replayOrderStreamDeterministically, type EvidenceOrderReducer } from "./replay.js";
import { Sha256Schema } from "./schemas.js";
import { snapshotEventStream } from "./fingerprints.js";

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

export interface ReducerArtifactEvidenceResult {
  schemaVersion: 1;
  reducerSha256: string;
  stream: ReturnType<typeof snapshotEventStream>["evidence"];
  candidate: ReturnType<typeof replayOrderStreamDeterministically>["candidate"];
  reducerDeterministic: true;
}

export interface ReducerArtifactEvidenceLimits {
  maxEvents?: number;
  maxCanonicalBytes?: number;
}

function isOrderReducer(value: unknown): value is EvidenceOrderReducer {
  return typeof value === "function";
}

export async function sha256File(pathInput: string): Promise<string> {
  const bytes = await readFile(resolve(pathInput));
  return createHash("sha256").update(bytes).digest("hex");
}

export async function runReducerArtifactEvidence(
  artifactPathInput: string,
  input: unknown,
  limits: ReducerArtifactEvidenceLimits = {},
): Promise<ReducerArtifactEvidenceResult> {
  const parsed = ReducerArtifactEvidenceInputSchema.parse(input);
  const artifactPath = resolve(artifactPathInput);
  const reducerSha256 = await sha256File(artifactPath);
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
  const artifactUrl = new URL(pathToFileURL(artifactPath));
  artifactUrl.searchParams.set("sha256", reducerSha256);
  const reducerModule = (await import(artifactUrl.href)) as { reduceOrder?: unknown };
  if (!isOrderReducer(reducerModule.reduceOrder)) {
    throw new Error("Reducer artifact must export reduceOrder");
  }
  const replay = replayOrderStreamDeterministically(snapshot.events, reducerModule.reduceOrder);
  return {
    schemaVersion: 1,
    reducerSha256,
    stream: snapshot.evidence,
    candidate: replay.candidate,
    reducerDeterministic: replay.deterministic,
  };
}
