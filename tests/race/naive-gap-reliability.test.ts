import { reproduceNaiveGap, resetNaiveGapFixture } from "@projection-witness/demo-driver";
import { createDatabasePool, migrateDatabase } from "@projection-witness/database";
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
    for (let repetition = 1; repetition <= 10; repetition += 1) {
      await resetNaiveGapFixture(pool);
      const evidence = await reproduceNaiveGap(pool);

      expect(evidence, `repetition ${String(repetition)}`).toMatchObject({
        pendingPaymentPosition: "3",
        unrelatedCommittedPosition: "4",
        checkpointPosition: "4",
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
