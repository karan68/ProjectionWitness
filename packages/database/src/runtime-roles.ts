import type { Pool, PoolClient } from "pg";
import { z } from "zod";

const RuntimeRoleSchema = z.enum(["pw_api", "pw_projector", "pw_mcp_read", "pw_mcp_write"]);
const PasswordSchema = z.string().min(16).max(1_024);

export type RuntimeRole = z.infer<typeof RuntimeRoleSchema>;

export interface RuntimeRoleUrls {
  pw_api: string;
  pw_projector: string;
  pw_mcp_read: string;
  pw_mcp_write: string;
}

export interface ProvisionRuntimeRolesInput {
  migratorUrl: string;
  runtimeUrls: RuntimeRoleUrls;
}

interface QuotedLiteralRow {
  quoted_password: string;
}

function normalizedTarget(url: URL): string {
  const port = url.port === "" ? "5432" : url.port;
  return `${url.hostname.toLowerCase()}:${port}${url.pathname}`;
}

function parseRoleUrl(role: RuntimeRole, rawUrl: string, migratorTarget: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(`${role} database URL must use PostgreSQL`);
  }
  if (decodeURIComponent(parsed.username) !== role) {
    throw new Error(`${role} database URL must authenticate as ${role}`);
  }
  if (normalizedTarget(parsed) !== migratorTarget) {
    throw new Error(`${role} database URL must target the migrator database`);
  }
  return PasswordSchema.parse(decodeURIComponent(parsed.password));
}

async function setRolePassword(
  client: PoolClient,
  role: RuntimeRole,
  password: string,
): Promise<void> {
  const result = await client.query<QuotedLiteralRow>(
    "SELECT quote_literal($1::text) AS quoted_password",
    [password],
  );
  const quotedPassword = result.rows[0]?.quoted_password;
  if (quotedPassword === undefined) {
    throw new Error(`PostgreSQL did not quote the ${role} password`);
  }

  // Role identifiers are closed over the fixed allowlist; only PostgreSQL-quoted literals vary.
  const statements: Record<RuntimeRole, string> = {
    pw_api: `ALTER ROLE pw_api LOGIN PASSWORD ${quotedPassword}`,
    pw_projector: `ALTER ROLE pw_projector LOGIN PASSWORD ${quotedPassword}`,
    pw_mcp_read: `ALTER ROLE pw_mcp_read LOGIN PASSWORD ${quotedPassword}`,
    pw_mcp_write: `ALTER ROLE pw_mcp_write LOGIN PASSWORD ${quotedPassword}`,
  };
  await client.query(statements[role]);
}

export async function provisionRuntimeRoles(
  pool: Pool,
  input: ProvisionRuntimeRolesInput,
): Promise<void> {
  const migrator = new URL(input.migratorUrl);
  if (decodeURIComponent(migrator.username) !== "pw_migrator") {
    throw new Error("Migrator URL must authenticate as pw_migrator");
  }
  const migratorTarget = normalizedTarget(migrator);
  const roles = RuntimeRoleSchema.options;
  const passwords = new Map<RuntimeRole, string>();
  for (const role of roles) {
    passwords.set(role, parseRoleUrl(role, input.runtimeUrls[role], migratorTarget));
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const role of roles) {
      const password = passwords.get(role);
      if (password === undefined) {
        throw new Error(`Missing validated password for ${role}`);
      }
      await setRolePassword(client, role, password);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
