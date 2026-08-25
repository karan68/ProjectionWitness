import { reproduceNaiveGap, resetNaiveGapFixture } from "@projection-witness/demo-driver";
import { createDatabasePool, migrateDatabase } from "@projection-witness/database";
import { requireDemoDatabaseUrl } from "./demo-environment.js";

const pool = createDatabasePool({
  databaseUrl: requireDemoDatabaseUrl(),
  applicationName: "projection-witness-gap-reproducer",
  maxConnections: 8,
});

try {
  await migrateDatabase(pool);
  await resetNaiveGapFixture(pool);
  const evidence = await reproduceNaiveGap(pool);
  console.log(JSON.stringify({ event: "demo.gap_reproduced", evidence }));
} finally {
  await pool.end();
}
