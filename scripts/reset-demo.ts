import { resetNaiveGapFixture } from "@projection-witness/demo-driver";
import { createDatabasePool, migrateDatabase } from "@projection-witness/database";
import { requireDemoDatabaseUrl } from "./demo-environment.js";

const pool = createDatabasePool({
  databaseUrl: requireDemoDatabaseUrl(),
  applicationName: "projection-witness-demo-reset",
  maxConnections: 1,
});

try {
  await migrateDatabase(pool);
  await resetNaiveGapFixture(pool);
  console.log(JSON.stringify({ event: "demo.reset", orderId: "ORD-1042" }));
} finally {
  await pool.end();
}
