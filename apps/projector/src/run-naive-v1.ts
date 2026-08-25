import { createDatabasePool } from "@projection-witness/database";
import { setTimeout as delay } from "node:timers/promises";
import { NaiveOrderProjector } from "./naive-projector.js";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const databaseUrl = environmentVariable("DATABASE_URL_PROJECTOR");
if (databaseUrl === undefined || databaseUrl === "") {
  throw new Error("DATABASE_URL_PROJECTOR is required");
}
if (environmentVariable("PROJECTOR_MODE") !== "naive-v1") {
  throw new Error("PROJECTOR_MODE=naive-v1 is required");
}

const pool = createDatabasePool({
  databaseUrl,
  applicationName: "projection-witness-projector-v1",
});
const projector = new NaiveOrderProjector(pool);
const abortController = new AbortController();
process.once("SIGINT", () => abortController.abort());
process.once("SIGTERM", () => abortController.abort());

try {
  while (!abortController.signal.aborted) {
    const result = await projector.poll();
    if (result.processedCount > 0) {
      console.log(JSON.stringify({ event: "projector.poll", ...result }));
    }
    await delay(250, undefined, { signal: abortController.signal }).catch(() => undefined);
  }
} finally {
  await pool.end();
}
