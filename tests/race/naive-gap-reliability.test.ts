import { reproduceNaiveGap } from "@projection-witness/demo-driver";
import { createDatabasePool, migrateDatabase } from "@projection-witness/database";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const databaseUrl = environmentVariable("DATABASE_URL_MIGRATOR") ?? "";
const describeWithDatabase = databaseUrl === "" ? describe.skip : describe;

describeWithDatabase("naive gap reliability", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createDatabasePool({
      databaseUrl,
      applicationName: "projection-witness-gap-reliability",
      maxConnections: 8,
    });
    await migrateDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("reproduces the genuine gap ten consecutive times", async () => {
    const runId = randomUUID();
    const projectionName = `orders-reliability-${runId}`;
    await pool.query(
      `INSERT INTO projection_checkpoints (projection_name, last_global_position)
       SELECT $1, COALESCE(max(global_position), 0)
       FROM events`,
      [projectionName],
    );
    for (let repetition = 1; repetition <= 10; repetition += 1) {
      const evidence = await reproduceNaiveGap(pool, {
        projectionName,
        targetOrderId: `ORD-RELIABILITY-A-${runId}-${String(repetition)}`,
        unrelatedOrderId: `ORD-RELIABILITY-B-${runId}-${String(repetition)}`,
      });

      expect(
        BigInt(evidence.pendingPaymentPosition),
        `repetition ${String(repetition)}`,
      ).toBeLessThan(BigInt(evidence.unrelatedCommittedPosition));
      expect(evidence.checkpointPosition).toBe(evidence.unrelatedCommittedPosition);
      expect(evidence, `repetition ${String(repetition)}`).toMatchObject({
        customerState: {
          paidCents: 0,
          paymentStatus: "AWAITING_PAYMENT",
          lastStreamVersion: 1,
        },
        replayedState: {
          paidCents: 12_900,
          paymentStatus: "PAID",
          lastStreamVersion: 2,
        },
        laterPollProcessedCount: 0,
      });
    }
  });
});
