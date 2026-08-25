import { createDatabasePool } from "@projection-witness/database";
import { z } from "zod";
import { buildOrderApi } from "./order-api.js";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const databaseUrl = environmentVariable("DATABASE_URL_API");
if (databaseUrl === undefined || databaseUrl === "") {
  throw new Error("DATABASE_URL_API is required");
}
const port = z.coerce
  .number()
  .int()
  .positive()
  .max(65_535)
  .parse(environmentVariable("API_PORT") ?? 3_000);
const pool = createDatabasePool({
  databaseUrl,
  applicationName: "projection-witness-api",
});
const app = buildOrderApi(pool, { logger: true });

const close = async (): Promise<void> => {
  await app.close();
  await pool.end();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

await app.listen({ host: "127.0.0.1", port });
