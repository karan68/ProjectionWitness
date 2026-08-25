import { ProjectionWitnessTools } from "@projection-witness/mcp";
import type { ProjectionRepairService } from "@projection-witness/repair";
import {
  createDatabasePool,
  GapAwareAlgorithmVersion,
  migrateDatabase,
  OrderEventStore,
  registerProjectionRuntime,
  TrackedNonBlockingGapStrategy,
} from "@projection-witness/database";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const migratorUrl = environmentVariable("DATABASE_URL_MIGRATOR") ?? "";
const readUrl = environmentVariable("DATABASE_URL_MCP_READ") ?? "";
const describeWithDatabase = migratorUrl === "" || readUrl === "" ? describe.skip : describe;

describeWithDatabase("MCP read tools", () => {
  let migratorPool: Pool;
  let readPool: Pool;
  let tools: ProjectionWitnessTools;
  let streamId: string;
  let projectionName: string;

  beforeAll(async () => {
    migratorPool = createDatabasePool({
      databaseUrl: migratorUrl,
      applicationName: "projection-witness-mcp-migrator-test",
    });
    readPool = createDatabasePool({
      databaseUrl: readUrl,
      applicationName: "projection-witness-mcp-read-handler-test",
    });
    await migrateDatabase(migratorPool);
    const suffix = randomUUID();
    streamId = `ORD-MCP-${suffix}`;
    projectionName = `orders-mcp-${suffix}`;
    const store = new OrderEventStore(migratorPool);
    await store.append({
      streamId,
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 5_000 },
    });
    await migratorPool.query(
      `INSERT INTO order_view (
         order_id, total_cents, paid_cents, payment_status,
         fulfillment_status, last_stream_version, row_version
       ) VALUES ($1, 5000, 0, 'AWAITING_PAYMENT', 'NOT_SHIPPED', 1, 1)`,
      [streamId],
    );
    await migratorPool.query(
      "INSERT INTO projection_checkpoints (projection_name, last_global_position) VALUES ($1, 1)",
      [projectionName],
    );
    await registerProjectionRuntime(migratorPool, {
      projectionName,
      generation: "2",
      reducerSha256: "a".repeat(64),
      sourceCommitSha: "mcp-tools-test",
      algorithmVersion: GapAwareAlgorithmVersion,
      gapStrategy: TrackedNonBlockingGapStrategy,
    });
    tools = new ProjectionWitnessTools({
      readPool,
      repairService: {} as ProjectionRepairService,
      apiBaseUrl: "http://127.0.0.1:3000",
    });
  });

  afterAll(async () => {
    await Promise.all([readPool.end(), migratorPool.end()]);
  });

  it("resolves and inspects an exact projection case", async () => {
    expect(await tools.findProjectionCase({ orderId: streamId })).toEqual({
      found: true,
      streamExists: true,
      projectionExists: true,
    });
    const inspected = await tools.inspectProjectionCase({ orderId: streamId, projectionName });
    expect(inspected).toMatchObject({
      row: { orderId: streamId, totalCents: "5000", rowVersion: "1" },
      checkpoint: "1",
      gapPositions: [],
    });
  });

  it("returns bounded canonical stream evidence and refuses a lower count limit", async () => {
    const snapshot = await tools.snapshotEventStream({
      streamId,
      maxEvents: 1,
      maxCanonicalBytes: 1_048_576,
    });
    expect(snapshot.evidence).toMatchObject({ streamId, headVersion: 1, eventCount: 1 });
    await expect(
      tools.snapshotEventStream({ streamId, maxEvents: 1, maxCanonicalBytes: 1 }),
    ).rejects.toThrow(/byte limit/);
  });

  it("returns public-safe runtime identity and exact not-found behavior", async () => {
    expect(await tools.getProjectionRuntime({ projectionName })).toMatchObject({
      runtime: {
        projectionName,
        generation: "2",
        sourceCommitSha: "mcp-tools-test",
      },
    });
    expect(await tools.findProjectionCase({ orderId: `MISSING-${randomUUID()}` })).toEqual({
      found: false,
      streamExists: false,
      projectionExists: false,
    });
    await expect(tools.verifyProjectionRepair({ planId: randomUUID() })).rejects.toMatchObject({
      code: "CASE_NOT_FOUND",
      message: "Repair plan was not found",
    });
  });
});
