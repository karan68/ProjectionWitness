import {
  createDatabasePool,
  GapAwareAlgorithmVersion,
  getProjectionRuntime,
  migrateDatabase,
  OrderEventStore,
  registerProjectionRuntime,
  TrackedNonBlockingGapStrategy,
} from "@projection-witness/database";
import {
  buildRepairEnvelope,
  fingerprintCurrentProjectionRow,
  fingerprintRuntime,
  runReducerArtifactEvidence,
  snapshotEventStream,
} from "@projection-witness/evidence";
import { GapAwareOrderProjector } from "@projection-witness/projector";
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
const mcpReadUrl = environmentVariable("DATABASE_URL_MCP_READ") ?? "";
if (migratorUrl === "" || apiUrl === "" || projectorUrl === "" || mcpReadUrl === "") {
  throw new Error("PostgreSQL evidence tests require migrator, API, projector, and read URLs");
}

interface ProjectionEvidenceRow {
  order_id: string;
  total_cents: string;
  paid_cents: string;
  payment_status: string;
  fulfillment_status: string;
  last_stream_version: number;
  row_version: string;
}

describe("PostgreSQL canonical evidence snapshots", () => {
  let migratorPool: Pool;
  let apiPool: Pool;
  let projectorPool: Pool;
  let mcpReadPool: Pool;
  let reducerBundle: ReducerBundleResult;

  beforeAll(async () => {
    migratorPool = createDatabasePool({
      databaseUrl: migratorUrl,
      applicationName: "projection-witness-evidence-migrator-test",
    });
    apiPool = createDatabasePool({
      databaseUrl: apiUrl,
      applicationName: "projection-witness-evidence-api-test",
    });
    projectorPool = createDatabasePool({
      databaseUrl: projectorUrl,
      applicationName: "projection-witness-evidence-projector-test",
    });
    mcpReadPool = createDatabasePool({
      databaseUrl: mcpReadUrl,
      applicationName: "projection-witness-evidence-read-test",
    });
    await migrateDatabase(migratorPool);
    reducerBundle = await buildReducerBundle();
  });

  afterAll(async () => {
    await Promise.all([mcpReadPool.end(), projectorPool.end(), apiPool.end(), migratorPool.end()]);
  });

  it("keeps stream, row, runtime, and envelope digests stable across repeated reads", async () => {
    const suffix = randomUUID();
    const streamId = `ORD-EVIDENCE-${suffix}`;
    const projectionName = `orders-evidence-${suffix}`;
    await projectorPool.query(
      `INSERT INTO projection_checkpoints (projection_name, last_global_position)
       SELECT $1, COALESCE(max(global_position), 0)
       FROM events`,
      [projectionName],
    );
    const apiStore = new OrderEventStore(apiPool);
    await apiStore.append({
      streamId,
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 12_900 },
      metadata: { source: "evidence-integration" },
    });
    await apiStore.append({
      streamId,
      expectedVersion: 1,
      event: { type: "PaymentCaptured", paymentId: `PAY-${suffix}`, amountCents: 12_900 },
    });
    const projector = new GapAwareOrderProjector(projectorPool, { projectionName });
    expect((await projector.poll()).processedCount).toBe(2);

    const readStore = new OrderEventStore(mcpReadPool);
    const streamHead = await mcpReadPool.query<{ version: number }>(
      "SELECT version FROM event_streams WHERE stream_id = $1",
      [streamId],
    );
    const headVersion = streamHead.rows[0]?.version;
    expect(headVersion).toBe(2);
    const firstStream = snapshotEventStream({
      streamId,
      headVersion: headVersion ?? 0,
      events: await readStore.loadStream(streamId),
    });
    const secondStream = snapshotEventStream({
      streamId,
      headVersion: headVersion ?? 0,
      events: await readStore.loadStream(streamId),
    });
    expect(secondStream.evidence.sha256).toBe(firstStream.evidence.sha256);
    expect(secondStream.evidence.canonicalBytes).toBe(firstStream.evidence.canonicalBytes);

    const readProjectionRow = async (): Promise<ProjectionEvidenceRow> => {
      const result = await mcpReadPool.query<ProjectionEvidenceRow>(
        `SELECT
           order_id,
           total_cents::text,
           paid_cents::text,
           payment_status,
           fulfillment_status,
           last_stream_version,
           row_version::text
         FROM order_view
         WHERE order_id = $1`,
        [streamId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("Projected evidence row is missing");
      }
      return row;
    };
    const canonicalRow = (row: ProjectionEvidenceRow) => ({
      orderId: row.order_id,
      totalCents: row.total_cents,
      paidCents: row.paid_cents,
      paymentStatus: row.payment_status,
      fulfillmentStatus: row.fulfillment_status,
      lastStreamVersion: row.last_stream_version,
      rowVersion: row.row_version,
    });
    const firstRow = fingerprintCurrentProjectionRow(canonicalRow(await readProjectionRow()));
    await migratorPool.query(
      "UPDATE order_view SET updated_at = clock_timestamp() WHERE order_id = $1",
      [streamId],
    );
    const secondRow = fingerprintCurrentProjectionRow(canonicalRow(await readProjectionRow()));
    expect(secondRow.sha256).toBe(firstRow.sha256);

    const reducerEvidence = await runReducerArtifactEvidence(reducerBundle.outputPath, {
      schemaVersion: 1,
      expectedReducerSha256: reducerBundle.sha256,
      streamId,
      headVersion: headVersion ?? 0,
      events: firstStream.events,
    });
    const registeredRuntime = await registerProjectionRuntime(projectorPool, {
      projectionName,
      generation: "2",
      reducerSha256: reducerEvidence.reducerSha256,
      sourceCommitSha: "evidence-integration-commit",
      algorithmVersion: GapAwareAlgorithmVersion,
      gapStrategy: TrackedNonBlockingGapStrategy,
    });
    const runtimeFromReadRole = await getProjectionRuntime(mcpReadPool, projectionName);
    expect(runtimeFromReadRole).toBeDefined();
    const runtimeValue = {
      projectionName: runtimeFromReadRole?.projectionName,
      generation: runtimeFromReadRole?.generation,
      reducerSha256: runtimeFromReadRole?.reducerSha256,
      sourceCommitSha: runtimeFromReadRole?.sourceCommitSha,
      algorithmVersion: runtimeFromReadRole?.algorithmVersion,
      gapStrategy: runtimeFromReadRole?.gapStrategy,
    };
    const runtimeFingerprint = fingerprintRuntime(runtimeValue);
    expect(runtimeFingerprint.sha256).toBe(
      fingerprintRuntime({
        projectionName: registeredRuntime.projectionName,
        generation: registeredRuntime.generation,
        reducerSha256: registeredRuntime.reducerSha256,
        sourceCommitSha: registeredRuntime.sourceCommitSha,
        algorithmVersion: registeredRuntime.algorithmVersion,
        gapStrategy: registeredRuntime.gapStrategy,
      }).sha256,
    );

    const envelopeInput = {
      planId: `60000000-0000-4000-8000-${suffix.replaceAll("-", "").slice(0, 12)}`,
      projectionName,
      runtime: runtimeFingerprint.value,
      currentRow: firstRow.value,
      reducerEvidence,
      clock: () => new Date("2026-08-26T04:00:00.000Z"),
    };
    const firstEnvelope = buildRepairEnvelope(envelopeInput);
    const secondEnvelope = buildRepairEnvelope(envelopeInput);
    expect(secondEnvelope.evidenceSha256).toBe(firstEnvelope.evidenceSha256);
    expect(firstEnvelope.candidateRow.value).toMatchObject({
      orderId: streamId,
      paidCents: "12900",
      paymentStatus: "PAID",
      lastStreamVersion: 2,
    });
  });
});
