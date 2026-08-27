const databaseEnvironmentBySuite = {
  integration: [
    "DATABASE_URL_MIGRATOR",
    "DATABASE_URL_API",
    "DATABASE_URL_PROJECTOR",
    "DATABASE_URL_MCP_READ",
    "DATABASE_URL_MCP_WRITE",
    "DATABASE_URL_REPAIR_EXECUTOR",
  ],
  race: ["DATABASE_URL_MIGRATOR"],
} as const;

const suite = process.argv[2];
if (suite !== "integration" && suite !== "race") {
  throw new Error("Expected database test suite to be integration or race");
}

const missing = databaseEnvironmentBySuite[suite].filter(
  (environmentName) =>
    process.env[environmentName]?.trim() === undefined ||
    process.env[environmentName]?.trim() === "",
);
if (missing.length > 0) {
  throw new Error(
    `${suite} tests require ${missing.join(", ")}; refusing to skip database-backed release tests`,
  );
}
