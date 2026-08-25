import { prepareProjectionRepairDemo } from "@projection-witness/demo-driver";
import { createDatabasePool, migrateDatabase, OrderEventStore } from "@projection-witness/database";
import { ProjectionRepairService } from "@projection-witness/repair";
import { buildReducerBundle, type ReducerBundleResult } from "../../scripts/lib/reducer-bundle.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const migratorUrl = environmentVariable("DATABASE_URL_MIGRATOR") ?? "";
const apiUrl = environmentVariable("DATABASE_URL_API") ?? "";
const projectorUrl = environmentVariable("DATABASE_URL_PROJECTOR") ?? "";
const readUrl = environmentVariable("DATABASE_URL_MCP_READ") ?? "";
const stagingUrl = environmentVariable("DATABASE_URL_MCP_WRITE") ?? "";
const executorUrl = environmentVariable("DATABASE_URL_REPAIR_EXECUTOR") ?? "";
const describeWithDatabase = [
  migratorUrl,
  apiUrl,
  projectorUrl,
  readUrl,
  stagingUrl,
  executorUrl,
].some((value) => value === "")
  ? describe.skip
  : describe;

describeWithDatabase("prepared projection repair demo", () => {
  let migratorPool: Pool;
  let apiPool: Pool;
  let projectorPool: Pool;
  let readPool: Pool;
  let stagingPool: Pool;
  let executorPool: Pool;
  let reducerBundle: ReducerBundleResult;

  beforeAll(async () => {
    migratorPool = createDatabasePool({
      databaseUrl: migratorUrl,
      applicationName: "demo-test-migrator",
    });
    apiPool = createDatabasePool({ databaseUrl: apiUrl, applicationName: "demo-test-api" });
    projectorPool = createDatabasePool({
      databaseUrl: projectorUrl,
      applicationName: "demo-test-projector",
    });
    readPool = createDatabasePool({ databaseUrl: readUrl, applicationName: "demo-test-read" });
    stagingPool = createDatabasePool({
      databaseUrl: stagingUrl,
      applicationName: "demo-test-staging",
    });
    executorPool = createDatabasePool({
      databaseUrl: executorUrl,
      applicationName: "demo-test-executor",
    });
    await migrateDatabase(migratorPool);
    reducerBundle = await buildReducerBundle();
  });

  afterAll(async () => {
    await Promise.all([
      executorPool.end(),
      stagingPool.end(),
      readPool.end(),
      projectorPool.end(),
      apiPool.end(),
      migratorPool.end(),
    ]);
  });

  it("stages an exact binding that applies one row, audits once, and reuses its receipt", async () => {
    const suffix = randomUUID();
    const streamId = `ORD-DEMO-${suffix}`;
    const projectionName = `orders-demo-${suffix}`;
    const store = new OrderEventStore(apiPool);
    await store.append({
      streamId,
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 12_900 },
    });
    await store.append({
      streamId,
      expectedVersion: 1,
      event: { type: "PaymentCaptured", paymentId: `PAY-${suffix}`, amountCents: 12_900 },
    });
    await projectorPool.query(
      `INSERT INTO order_view (
         order_id, total_cents, paid_cents, payment_status,
         fulfillment_status, last_stream_version, row_version
       ) VALUES ($1, 12900, 0, 'AWAITING_PAYMENT', 'NOT_SHIPPED', 1, 1)`,
      [streamId],
    );
    const prepared = await prepareProjectionRepairDemo(
      { projectorPool, readPool, stagingPool, executorPool },
      {
        reducerArtifactPath: reducerBundle.outputPath,
        sourceCommitSha: "a".repeat(40),
        targetOrderId: streamId,
        projectionName,
        clock: () => new Date(Date.now() - 1_000),
      },
    );
    expect(prepared.staged).toMatchObject({ created: true, status: "PREPARED" });
    expect(prepared.approval).toMatchObject({
      planId: prepared.envelope.planId,
      streamId,
      projectionName,
      evidenceSha256: prepared.envelope.evidenceSha256,
    });

    const repair = new ProjectionRepairService(stagingPool, {
      executorPool,
      reducerArtifactPath: reducerBundle.outputPath,
    });
    const applied = await repair.applyRepairPlan(prepared.approval);
    expect(applied).toMatchObject({ status: "APPLIED", planId: prepared.envelope.planId });
    await expect(repair.applyRepairPlan(prepared.approval)).resolves.toEqual({
      ...applied,
      status: "ALREADY_APPLIED",
    });
    const row = await readPool.query<{
      paid_cents: string;
      payment_status: string;
      last_stream_version: number;
      row_version: string;
    }>(
      `SELECT paid_cents::text, payment_status, last_stream_version, row_version::text
       FROM order_view WHERE order_id = $1`,
      [streamId],
    );
    expect(row.rows[0]).toEqual({
      paid_cents: "12900",
      payment_status: "PAID",
      last_stream_version: 2,
      row_version: "2",
    });
    const audit = await readPool.query("SELECT 1 FROM projection_repair_audit WHERE plan_id = $1", [
      prepared.envelope.planId,
    ]);
    expect(audit.rowCount).toBe(1);
  });
});
