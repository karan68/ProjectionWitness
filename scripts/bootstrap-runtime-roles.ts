import {
  createDatabasePool,
  provisionRuntimeRoles,
  type RuntimeRoleUrls,
} from "@projection-witness/database";

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

const migratorUrl = requiredEnvironmentVariable("DATABASE_URL_MIGRATOR");
const runtimeUrls: RuntimeRoleUrls = {
  pw_api: requiredEnvironmentVariable("DATABASE_URL_API"),
  pw_projector: requiredEnvironmentVariable("DATABASE_URL_PROJECTOR"),
  pw_mcp_read: requiredEnvironmentVariable("DATABASE_URL_MCP_READ"),
  pw_mcp_write: requiredEnvironmentVariable("DATABASE_URL_MCP_WRITE"),
  pw_repair_executor: requiredEnvironmentVariable("DATABASE_URL_REPAIR_EXECUTOR"),
};
const pool = createDatabasePool({
  databaseUrl: migratorUrl,
  applicationName: "projection-witness-role-bootstrap",
  maxConnections: 1,
});

try {
  await provisionRuntimeRoles(pool, { migratorUrl, runtimeUrls });
  console.log(JSON.stringify({ event: "database.runtime_roles_provisioned" }));
} finally {
  await pool.end();
}
