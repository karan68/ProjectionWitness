import { PreparedProjectionRepairDemoFileSchema } from "@projection-witness/demo-driver";
import { createDatabasePool } from "@projection-witness/database";
import { OrderProjectionSchema } from "@projection-witness/domain";
import {
  fingerprintCandidateProjection,
  fingerprintCurrentProjectionRow,
} from "@projection-witness/evidence";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

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

const planPathInput = process.argv[2];
if (planPathInput === undefined) {
  throw new Error(
    "Usage: npm run demo:verify-repair -- <prepared-demo-plan.json> <PREPARED|APPLIED>",
  );
}
const expectedStatus = z.enum(["PREPARED", "APPLIED"]).parse(process.argv[3]);
const planPath = resolve(planPathInput);
const planStats = await stat(planPath);
if (!planStats.isFile() || planStats.size > 131_072) {
  throw new Error("Prepared demo plan must be a file no larger than 131072 bytes");
}
const prepared = PreparedProjectionRepairDemoFileSchema.parse(
  JSON.parse(await readFile(planPath, "utf8")),
);
const readPool = createDatabasePool({
  databaseUrl: requiredEnvironmentVariable("DATABASE_URL_MCP_READ"),
  applicationName: "projection-witness-demo-independent-verifier",
});

try {
  const [plan, audit, row] = await Promise.all([
    readPool.query<{ status: string; stream_id: string }>(
      "SELECT status, stream_id FROM projection_repair_plans WHERE plan_id = $1",
      [prepared.approval.planId],
    ),
    readPool.query<{ receipt_sha256: string; after_row_sha256: string }>(
      `SELECT receipt_sha256, after_row_sha256
       FROM projection_repair_audit WHERE plan_id = $1`,
      [prepared.approval.planId],
    ),
    readPool.query<{
      order_id: string;
      total_cents: string;
      paid_cents: string;
      payment_status: string;
      fulfillment_status: string;
      last_stream_version: number;
      row_version: string;
    }>(
      `SELECT
         order_id, total_cents::text, paid_cents::text, payment_status,
         fulfillment_status, last_stream_version, row_version::text
       FROM order_view WHERE order_id = $1`,
      [prepared.approval.streamId],
    ),
  ]);
  const planRow = plan.rows[0];
  const projectionRow = row.rows[0];
  if (
    planRow === undefined ||
    planRow.status !== expectedStatus ||
    planRow.stream_id !== prepared.approval.streamId ||
    projectionRow === undefined
  ) {
    throw new Error(
      "Persisted demo plan, status, or projection row does not match the prepared case",
    );
  }
  const current = {
    orderId: projectionRow.order_id,
    totalCents: projectionRow.total_cents,
    paidCents: projectionRow.paid_cents,
    paymentStatus: projectionRow.payment_status,
    fulfillmentStatus: projectionRow.fulfillment_status,
    lastStreamVersion: projectionRow.last_stream_version,
    rowVersion: projectionRow.row_version,
  };
  const apiUrl = new URL(
    `/orders/${encodeURIComponent(prepared.approval.streamId)}`,
    environmentVariable("API_BASE_URL") ?? "http://127.0.0.1:3000",
  );
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(3_000) });
  const responseText = await response.text();
  if (response.status !== 200 || Buffer.byteLength(responseText, "utf8") > 1_048_576) {
    throw new Error("Public API verification failed or exceeded the response limit");
  }
  const publicState = OrderProjectionSchema.parse(JSON.parse(responseText));
  if (publicState.orderId !== prepared.approval.streamId) {
    throw new Error("Public API returned a different order");
  }

  const auditRow = audit.rows[0];
  if (expectedStatus === "PREPARED") {
    if (
      auditRow !== undefined ||
      fingerprintCurrentProjectionRow(current).sha256 !== prepared.summary.currentRowSha256 ||
      publicState.paymentStatus !== "AWAITING_PAYMENT"
    ) {
      throw new Error("Prepared/denied demo state contains an unexpected repair mutation");
    }
  } else {
    const { rowVersion: _rowVersion, ...business } = current;
    if (
      auditRow === undefined ||
      auditRow.after_row_sha256 !== prepared.summary.candidateRowSha256 ||
      fingerprintCandidateProjection(business).sha256 !== prepared.summary.candidateRowSha256 ||
      BigInt(current.rowVersion) !== BigInt(prepared.summary.currentRowVersion) + 1n ||
      publicState.paymentStatus !== "PAID"
    ) {
      throw new Error("Applied demo state does not match its candidate and audit evidence");
    }
  }

  console.log(
    JSON.stringify({
      event: "demo.repair_verified",
      expectedStatus,
      planId: prepared.approval.planId,
      streamId: prepared.approval.streamId,
      rowVersion: current.rowVersion,
      paymentStatus: current.paymentStatus,
      auditReceiptSha256: auditRow?.receipt_sha256 ?? null,
      publicPaymentStatus: publicState.paymentStatus,
    }),
  );
} finally {
  await readPool.end();
}
