import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const MigrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const DefaultMigrationsDirectory = fileURLToPath(
  new URL("../../../db/migrations/", import.meta.url),
);

interface AppliedMigrationRow {
  checksum_sha256: string;
}

export interface MigrationResult {
  applied: readonly string[];
  alreadyApplied: readonly string[];
}

export async function migrateDatabase(
  pool: Pool,
  migrationsDirectory = DefaultMigrationsDirectory,
): Promise<MigrationResult> {
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => MigrationFilePattern.test(filename))
    .sort((left, right) => left.localeCompare(right));

  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('projection-witness-migrations'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY,
         checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
         applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`,
    );

    for (const filename of filenames) {
      const sql = await readFile(join(migrationsDirectory, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<AppliedMigrationRow>(
        "SELECT checksum_sha256 FROM schema_migrations WHERE version = $1",
        [filename],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (row.checksum_sha256 !== checksum) {
          throw new Error(`Applied migration ${filename} has a different SHA-256 checksum`);
        }
        alreadyApplied.push(filename);
        continue;
      }

      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version, checksum_sha256) VALUES ($1, $2)",
        [filename, checksum],
      );
      applied.push(filename);
    }

    await client.query("COMMIT");
    return { applied, alreadyApplied };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The migration failure remains authoritative.
    }
    throw error;
  } finally {
    client.release();
  }
}
