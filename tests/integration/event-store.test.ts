import {
  ExpectedVersionConflictError,
  InvalidOrderStreamError,
  OrderEventStore,
  createDatabasePool,
  migrateDatabase,
} from "@projection-witness/database";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

function environmentVariable(name: string): string | undefined {
  return process.env[name];
}

const databaseUrl = environmentVariable("DATABASE_URL_MIGRATOR") ?? "";
const describeWithDatabase = databaseUrl === "" ? describe.skip : describe;

describeWithDatabase("PostgreSQL order event store", () => {
  let pool: Pool;
  let eventStore: OrderEventStore;

  beforeAll(async () => {
    pool = createDatabasePool({
      databaseUrl,
      applicationName: "projection-witness-integration-test",
      maxConnections: 8,
    });
    await migrateDatabase(pool);
    eventStore = new OrderEventStore(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE events, event_streams CASCADE");
    await pool.query("ALTER SEQUENCE event_global_position_seq RESTART WITH 1");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("appends a typed stream at exact expected versions", async () => {
    const placed = await eventStore.append({
      streamId: "ORD-1042",
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 12_900 },
      metadata: { source: "integration-test" },
    });
    const paid = await eventStore.append({
      streamId: "ORD-1042",
      expectedVersion: 1,
      event: {
        type: "PaymentCaptured",
        paymentId: "PAY-1",
        amountCents: 12_900,
      },
    });

    expect(placed).toMatchObject({
      globalPosition: "1",
      streamVersion: 1,
      eventType: "OrderPlaced",
    });
    expect(paid).toMatchObject({
      globalPosition: "2",
      streamVersion: 2,
      eventType: "PaymentCaptured",
    });

    const stream = await eventStore.loadStream("ORD-1042");
    expect(stream.map((event) => event.streamVersion)).toEqual([1, 2]);
    expect(stream[0]?.metadata).toEqual({ source: "integration-test" });
  });

  it("allows exactly one concurrent append at the same expected version", async () => {
    const attempts = await Promise.allSettled([
      eventStore.append({
        streamId: "ORD-RACE",
        expectedVersion: 0,
        event: { type: "OrderPlaced", totalCents: 100 },
      }),
      eventStore.append({
        streamId: "ORD-RACE",
        expectedVersion: 0,
        event: { type: "OrderPlaced", totalCents: 200 },
      }),
    ]);

    const successes = attempts.filter((result) => result.status === "fulfilled");
    const failures = attempts
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason as unknown);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(ExpectedVersionConflictError);

    const stream = await eventStore.loadStream("ORD-RACE");
    expect(stream).toHaveLength(1);
    expect(stream[0]?.streamVersion).toBe(1);
  });

  it("rolls back stale and invalid append attempts without adding an event", async () => {
    await eventStore.append({
      streamId: "ORD-1042",
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 100 },
    });

    await expect(
      eventStore.append({
        streamId: "ORD-1042",
        expectedVersion: 0,
        event: { type: "OrderShipped", shipmentId: "SHIP-1" },
      }),
    ).rejects.toBeInstanceOf(ExpectedVersionConflictError);

    await expect(
      eventStore.append({
        streamId: "ORD-1042",
        expectedVersion: 1,
        event: { type: "OrderPlaced", totalCents: 100 },
      }),
    ).rejects.toBeInstanceOf(InvalidOrderStreamError);

    expect(await eventStore.loadStream("ORD-1042")).toHaveLength(1);
  });

  it("rejects event updates and deletes through permissions and a defensive trigger", async () => {
    const event = await eventStore.append({
      streamId: "ORD-IMMUTABLE",
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 100 },
    });

    await expect(
      pool.query("UPDATE events SET metadata = '{}'::jsonb WHERE event_id = $1", [event.eventId]),
    ).rejects.toThrow(/events are immutable/);
    await expect(
      pool.query("DELETE FROM events WHERE event_id = $1", [event.eventId]),
    ).rejects.toThrow(/events are immutable/);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE pw_api");
      await expect(
        client.query("UPDATE events SET metadata = '{}'::jsonb WHERE event_id = $1", [
          event.eventId,
        ]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("applies migrations idempotently and records their checksum", async () => {
    const result = await migrateDatabase(pool);

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toContain("0001_event_store.sql");

    const migration = await pool.query<{ checksum_sha256: string }>(
      "SELECT checksum_sha256 FROM schema_migrations WHERE version = $1",
      ["0001_event_store.sql"],
    );
    expect(migration.rows[0]?.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an applied migration whose file checksum has drifted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "projection-witness-migrations-"));
    try {
      await writeFile(join(directory, "0001_event_store.sql"), "SELECT 1;\n", "utf8");

      await expect(migrateDatabase(pool, directory)).rejects.toThrow(/different SHA-256 checksum/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
