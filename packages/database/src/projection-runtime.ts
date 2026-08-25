import type { Pool, PoolClient } from "pg";
import { z } from "zod";

export const GapAwareAlgorithmVersion = "gap-aware-v1";
export const TrackedNonBlockingGapStrategy = "TRACKED_NON_BLOCKING";

const ProjectionRuntimeManifestSchema = z.object({
  projectionName: z.string().trim().min(1).max(128),
  generation: z.string().regex(/^[1-9][0-9]*$/),
  reducerSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceCommitSha: z.string().trim().min(1).max(128),
  algorithmVersion: z.string().trim().min(1).max(128),
  gapStrategy: z.string().trim().min(1).max(128),
});

interface ProjectionRuntimeRow {
  projection_name: string;
  generation: string;
  reducer_sha256: string;
  source_commit_sha: string;
  algorithm_version: string;
  gap_strategy: string;
  registered_at: Date;
}

export interface ProjectionRuntimeManifest {
  projectionName: string;
  generation: string;
  reducerSha256: string;
  sourceCommitSha: string;
  algorithmVersion: string;
  gapStrategy: string;
}

export interface ProjectionRuntime extends ProjectionRuntimeManifest {
  registeredAt: Date;
}

export type ProjectionRuntimeSafetyCode = "ROOT_CAUSE_UNSAFE" | "RUNTIME_UNATTESTED";

export class ProjectionRuntimeSafetyError extends Error {
  readonly code: ProjectionRuntimeSafetyCode;

  constructor(code: ProjectionRuntimeSafetyCode, message: string) {
    super(message);
    this.name = "ProjectionRuntimeSafetyError";
    this.code = code;
  }
}

function runtimeFromRow(row: ProjectionRuntimeRow): ProjectionRuntime {
  return {
    projectionName: row.projection_name,
    generation: row.generation,
    reducerSha256: row.reducer_sha256,
    sourceCommitSha: row.source_commit_sha,
    algorithmVersion: row.algorithm_version,
    gapStrategy: row.gap_strategy,
    registeredAt: row.registered_at,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original registration failure remains authoritative.
  }
}

export async function getProjectionRuntime(
  pool: Pool,
  projectionName: string,
): Promise<ProjectionRuntime | undefined> {
  const parsedName = ProjectionRuntimeManifestSchema.shape.projectionName.parse(projectionName);
  const result = await pool.query<ProjectionRuntimeRow>(
    `SELECT
       projection_name,
       generation::text,
       reducer_sha256,
       source_commit_sha,
       algorithm_version,
       gap_strategy,
       registered_at
     FROM projection_runtime
     WHERE projection_name = $1`,
    [parsedName],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : runtimeFromRow(row);
}

export async function registerProjectionRuntime(
  pool: Pool,
  manifest: ProjectionRuntimeManifest,
): Promise<ProjectionRuntime> {
  const parsed = ProjectionRuntimeManifestSchema.parse(manifest);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('projection_runtime:' || $1, 0))",
      [parsed.projectionName],
    );
    const currentResult = await client.query<ProjectionRuntimeRow>(
      `SELECT
         projection_name,
         generation::text,
         reducer_sha256,
         source_commit_sha,
         algorithm_version,
         gap_strategy,
         registered_at
       FROM projection_runtime
       WHERE projection_name = $1
       FOR UPDATE`,
      [parsed.projectionName],
    );
    const currentRow = currentResult.rows[0];
    if (currentRow !== undefined) {
      const current = runtimeFromRow(currentRow);
      const sameManifest =
        current.generation === parsed.generation &&
        current.reducerSha256 === parsed.reducerSha256 &&
        current.sourceCommitSha === parsed.sourceCommitSha &&
        current.algorithmVersion === parsed.algorithmVersion &&
        current.gapStrategy === parsed.gapStrategy;
      if (sameManifest) {
        await client.query("COMMIT");
        return current;
      }
      if (BigInt(parsed.generation) <= BigInt(current.generation)) {
        throw new Error("Runtime generation must increase when the manifest changes");
      }
    }

    const registered = await client.query<ProjectionRuntimeRow>(
      `INSERT INTO projection_runtime (
         projection_name,
         generation,
         reducer_sha256,
         source_commit_sha,
         algorithm_version,
         gap_strategy
       )
       VALUES ($1, $2::bigint, $3, $4, $5, $6)
       ON CONFLICT (projection_name) DO UPDATE
       SET generation = EXCLUDED.generation,
           reducer_sha256 = EXCLUDED.reducer_sha256,
           source_commit_sha = EXCLUDED.source_commit_sha,
           algorithm_version = EXCLUDED.algorithm_version,
           gap_strategy = EXCLUDED.gap_strategy,
           registered_at = clock_timestamp()
         WHERE projection_runtime.generation < EXCLUDED.generation
       RETURNING
         projection_name,
         generation::text,
         reducer_sha256,
         source_commit_sha,
         algorithm_version,
         gap_strategy,
         registered_at`,
      [
        parsed.projectionName,
        parsed.generation,
        parsed.reducerSha256,
        parsed.sourceCommitSha,
        parsed.algorithmVersion,
        parsed.gapStrategy,
      ],
    );
    const row = registered.rows[0];
    if (row === undefined) {
      throw new Error("Runtime registration returned no manifest");
    }
    await client.query("COMMIT");
    return runtimeFromRow(row);
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export function assertRepairSafeProjectionRuntime(
  runtime: ProjectionRuntime | undefined,
): asserts runtime is ProjectionRuntime {
  if (runtime === undefined) {
    throw new ProjectionRuntimeSafetyError(
      "RUNTIME_UNATTESTED",
      "Projection runtime is not registered",
    );
  }
  if (
    runtime.algorithmVersion !== GapAwareAlgorithmVersion ||
    runtime.gapStrategy !== TrackedNonBlockingGapStrategy
  ) {
    throw new ProjectionRuntimeSafetyError(
      "ROOT_CAUSE_UNSAFE",
      "Gap-aware projector runtime is not active",
    );
  }
}
