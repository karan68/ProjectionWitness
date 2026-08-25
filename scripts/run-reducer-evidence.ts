import { runReducerArtifactEvidence } from "@projection-witness/evidence";
import { readFile, stat } from "node:fs/promises";

const MaximumEvidenceInputBytes = 2_097_152;

const artifactPath = process.argv[2];
const inputPath = process.argv[3];
if (artifactPath === undefined || inputPath === undefined) {
  throw new Error(
    "Usage: npm run evidence:run-reducer -- <reducer-artifact-path> <evidence-input.json>",
  );
}

const inputStats = await stat(inputPath);
if (!inputStats.isFile() || inputStats.size > MaximumEvidenceInputBytes) {
  throw new Error("Evidence input must be a file no larger than 2097152 bytes");
}
const input = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
const result = await runReducerArtifactEvidence(artifactPath, input);
console.log(JSON.stringify(result));
