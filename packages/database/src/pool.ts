import { Pool, type PoolConfig } from "pg";

export interface DatabasePoolOptions {
  databaseUrl: string;
  applicationName: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export function createDatabasePool(options: DatabasePoolOptions): Pool {
  const max = positiveInteger(options.maxConnections ?? 5, "maxConnections");
  const connectionTimeoutMillis = positiveInteger(
    options.connectionTimeoutMs ?? 2_000,
    "connectionTimeoutMs",
  );
  const statementTimeoutMs = positiveInteger(
    options.statementTimeoutMs ?? 5_000,
    "statementTimeoutMs",
  );
  const idleTransactionTimeoutMs = positiveInteger(
    options.idleTransactionTimeoutMs ?? 5_000,
    "idleTransactionTimeoutMs",
  );

  const config: PoolConfig = {
    connectionString: options.databaseUrl,
    application_name: options.applicationName,
    max,
    connectionTimeoutMillis,
    options: `-c statement_timeout=${String(statementTimeoutMs)} -c idle_in_transaction_session_timeout=${String(idleTransactionTimeoutMs)}`,
  };

  return new Pool(config);
}
