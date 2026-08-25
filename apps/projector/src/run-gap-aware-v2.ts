import {
  createDatabasePool,
  GapAwareAlgorithmVersion,
  registerProjectionRuntime,
  TrackedNonBlockingGapStrategy,
} from "@projection-witness/database";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { GapAwareOrderProjector, type OrderReducer } from "./gap-aware-projector.js";

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function isOrderReducer(value: unknown): value is OrderReducer {
  return typeof value === "function";
}

if (requiredEnvironmentVariable("PROJECTOR_MODE") !== GapAwareAlgorithmVersion) {
  throw new Error(`PROJECTOR_MODE=${GapAwareAlgorithmVersion} is required`);
}

const databaseUrl = requiredEnvironmentVariable("DATABASE_URL_PROJECTOR");
const projectionName = process.env["PROJECTION_NAME"]?.trim() || "orders";
const generation = requiredEnvironmentVariable("PROJECTOR_GENERATION");
const sourceCommitSha = requiredEnvironmentVariable("SOURCE_COMMIT_SHA");
const reducerBundlePath = resolve(requiredEnvironmentVariable("REDUCER_BUNDLE_PATH"));
const reducerBytes = await readFile(reducerBundlePath);
const reducerSha256 = createHash("sha256").update(reducerBytes).digest("hex");
const reducerModule = (await import(pathToFileURL(reducerBundlePath).href)) as {
  reduceOrder?: unknown;
};
if (!isOrderReducer(reducerModule.reduceOrder)) {
  throw new Error("REDUCER_BUNDLE_PATH must export reduceOrder");
}

const pool = createDatabasePool({
  databaseUrl,
  applicationName: "projection-witness-projector-v2",
});
const abortController = new AbortController();
process.once("SIGINT", () => abortController.abort());
process.once("SIGTERM", () => abortController.abort());

try {
  const runtime = await registerProjectionRuntime(pool, {
    projectionName,
    generation,
    reducerSha256,
    sourceCommitSha,
    algorithmVersion: GapAwareAlgorithmVersion,
    gapStrategy: TrackedNonBlockingGapStrategy,
  });
  console.log(
    JSON.stringify({
      event: "projector.runtime.registered",
      projectionName: runtime.projectionName,
      generation: runtime.generation,
      reducerSha256: runtime.reducerSha256,
      sourceCommitSha: runtime.sourceCommitSha,
    }),
  );

  const projector = new GapAwareOrderProjector(pool, {
    projectionName,
    reducer: reducerModule.reduceOrder,
  });
  while (!abortController.signal.aborted) {
    const result = await projector.poll();
    if (
      result.processedCount > 0 ||
      result.trackedGapPositions.length > 0 ||
      result.retiredGapPositions.length > 0
    ) {
      console.log(JSON.stringify({ event: "projector.poll", ...result }));
    }
    await delay(250, undefined, { signal: abortController.signal }).catch(() => undefined);
  }
} finally {
  await pool.end();
}
