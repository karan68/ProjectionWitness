import { verifyNaiveGap } from "@projection-witness/demo-driver";
import { createDatabasePool } from "@projection-witness/database";
import { requireDemoDatabaseUrl } from "./demo-environment.js";

const pool = createDatabasePool({
  databaseUrl: requireDemoDatabaseUrl(),
  applicationName: "projection-witness-demo-verifier",
  maxConnections: 2,
});

try {
  const evidence = await verifyNaiveGap(pool);
  console.log(JSON.stringify({ event: "demo.verified", evidence }));
} finally {
  await pool.end();
}
