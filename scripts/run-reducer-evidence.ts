import { runReducerArtifactEvidence } from "@projection-witness/evidence";
import { readFile } from "node:fs/promises";

const artifactPath = process.argv[2];
const inputPath = process.argv[3];
if (artifactPath === undefined || inputPath === undefined) {
  throw new Error(
    "Usage: npm run evidence:run-reducer -- <reducer-artifact-path> <evidence-input.json>",
  );
}

const input = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
const result = await runReducerArtifactEvidence(artifactPath, input);
console.log(JSON.stringify(result));
