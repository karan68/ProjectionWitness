import { createDatabasePool, migrateDatabase } from "@projection-witness/database";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const databaseUrl = environmentVariable("DATABASE_URL_MIGRATOR");
if (databaseUrl === undefined || databaseUrl === "") {
  throw new Error("DATABASE_URL_MIGRATOR is required");
}

const pool = createDatabasePool({
  databaseUrl,
  applicationName: "projection-witness-migrator",
  maxConnections: 1,
});

try {
  const result = await migrateDatabase(pool);
  console.log(JSON.stringify({ event: "database.migrated", ...result }));
} finally {
  await pool.end();
}
