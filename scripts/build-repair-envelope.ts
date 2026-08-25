import {
  buildRepairEnvelope,
  CurrentProjectionRowSchema,
  ReducerArtifactEvidenceInputSchema,
  runReducerArtifactEvidence,
  RuntimeEvidenceSchema,
} from "@projection-witness/evidence";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

const MaximumEnvelopeInputBytes = 2_097_152;
const EnvelopeBuildInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectionName: z.string().trim().min(1).max(128),
    runtime: RuntimeEvidenceSchema,
    currentRow: CurrentProjectionRowSchema,
    reducerInput: ReducerArtifactEvidenceInputSchema,
    ttlSeconds: z.number().int().positive().safe().max(3_600).default(300),
  })
  .strict();

const artifactPath = process.argv[2];
const inputPath = process.argv[3];
if (artifactPath === undefined || inputPath === undefined) {
  throw new Error(
    "Usage: npm run evidence:build-envelope -- <reducer-artifact-path> <envelope-input.json>",
  );
}
const inputStats = await stat(inputPath);
if (!inputStats.isFile() || inputStats.size > MaximumEnvelopeInputBytes) {
  throw new Error("Envelope input must be a file no larger than 2097152 bytes");
}
const input = EnvelopeBuildInputSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
const reducerEvidence = await runReducerArtifactEvidence(artifactPath, input.reducerInput);
const envelope = buildRepairEnvelope({
  planId: randomUUID(),
  projectionName: input.projectionName,
  runtime: input.runtime,
  currentRow: input.currentRow,
  reducerEvidence,
  ttlSeconds: input.ttlSeconds,
  clock: () => new Date(),
});
console.log(JSON.stringify(envelope));
