import {
  prepareProjectionRepairDemo,
  PreparedProjectionRepairDemoFileSchema,
} from "@projection-witness/demo-driver";
import { createDatabasePool } from "@projection-witness/database";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

function requiredEnvironmentVariable(name: string): string {
  const value = environmentVariable(name);
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

const sourceCommitSha = requiredEnvironmentVariable("SOURCE_COMMIT_SHA");
const reducerArtifactPath = requiredEnvironmentVariable("REDUCER_BUNDLE_PATH");
const projectorPool = createDatabasePool({
  databaseUrl: requiredEnvironmentVariable("DATABASE_URL_PROJECTOR"),
  applicationName: "projection-witness-demo-runtime",
});
const readPool = createDatabasePool({
  databaseUrl: requiredEnvironmentVariable("DATABASE_URL_MCP_READ"),
  applicationName: "projection-witness-demo-evidence",
});
const stagingPool = createDatabasePool({
  databaseUrl: requiredEnvironmentVariable("DATABASE_URL_MCP_WRITE"),
  applicationName: "projection-witness-demo-staging",
});
const executorPool = createDatabasePool({
  databaseUrl: requiredEnvironmentVariable("DATABASE_URL_REPAIR_EXECUTOR"),
  applicationName: "projection-witness-demo-executor",
});

try {
  const prepared = await prepareProjectionRepairDemo(
    { projectorPool, readPool, stagingPool, executorPool },
    {
      reducerArtifactPath,
      sourceCommitSha,
      ttlSeconds: Number(environmentVariable("PLAN_TTL_SECONDS") ?? "300"),
    },
  );
  const outputPath = resolve(
    environmentVariable("DEMO_REPAIR_PLAN_PATH") ??
      `.projection-witness/demo-repair-${prepared.envelope.planId}.json`,
  );
  const output = PreparedProjectionRepairDemoFileSchema.parse({
    schemaVersion: 1,
    approval: prepared.approval,
    summary: {
      planId: prepared.envelope.planId,
      projectionName: prepared.envelope.projectionName,
      streamId: prepared.envelope.stream.streamId,
      streamHeadVersion: prepared.envelope.stream.headVersion,
      streamSha256: prepared.envelope.stream.sha256,
      reducerSha256: prepared.envelope.runtime.reducerSha256,
      runtimeGeneration: prepared.envelope.runtime.generation,
      currentRowVersion: prepared.envelope.currentRow.rowVersion,
      currentRowSha256: prepared.envelope.currentRow.sha256,
      candidateRowSha256: prepared.envelope.candidateRow.sha256,
      expiresAt: prepared.envelope.expiresAt,
    },
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      event: "demo.repair_prepared",
      outputPath,
      staged: prepared.staged,
      approval: prepared.approval,
    }),
  );
} finally {
  await Promise.all([executorPool.end(), stagingPool.end(), readPool.end(), projectorPool.end()]);
}
