const LoopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

export function requireDemoDatabaseUrl(): string {
  if (environmentVariable("NODE_ENV") === "production") {
    throw new Error("Demo database operations refuse NODE_ENV=production");
  }
  if (environmentVariable("DEMO_MODE") !== "true") {
    throw new Error("DEMO_MODE=true is required for demo database operations");
  }

  const databaseUrl = environmentVariable("DATABASE_URL_MIGRATOR");
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL_MIGRATOR is required");
  }
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("Demo database operations require a PostgreSQL URL");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Demo database URL must not contain query parameters or a fragment");
  }
  if (!LoopbackHosts.has(parsed.hostname)) {
    throw new Error("Demo database operations require a loopback database host");
  }
  return databaseUrl;
}
