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

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error("Deferred promise resolver was not initialized");
  }
  return { promise, resolve: resolvePromise };
}

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

  it("rolls back creation when a missing stream is expected at a nonzero version", async () => {
    await expect(
      eventStore.append({
        streamId: "ORD-MISSING",
        expectedVersion: 5,
        event: { type: "OrderPlaced", totalCents: 100 },
      }),
    ).rejects.toMatchObject({
      code: "EXPECTED_VERSION_CONFLICT",
      expectedVersion: 5,
      actualVersion: 0,
    });

    expect(await eventStore.loadStream("ORD-MISSING")).toEqual([]);
    const streamHead = await pool.query("SELECT 1 FROM event_streams WHERE stream_id = $1", [
      "ORD-MISSING",
    ]);
    expect(streamHead.rowCount).toBe(0);
  });

  it("bounds lock waits, rolls back, and reuses the connection", async () => {
    await eventStore.append({
      streamId: "ORD-LOCKED",
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 100 },
    });

    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM event_streams WHERE stream_id = $1 FOR UPDATE", [
        "ORD-LOCKED",
      ]);

      const boundedStore = new OrderEventStore(pool, {
        lockTimeoutMs: 25,
        statementTimeoutMs: 1_000,
      });
      let failure: unknown;
      try {
        await boundedStore.append({
          streamId: "ORD-LOCKED",
          expectedVersion: 1,
          event: { type: "OrderShipped", shipmentId: "SHIP-LOCKED" },
        });
      } catch (error) {
        failure = error;
      }

      expect(postgresErrorCode(failure)).toBe("55P03");
      expect(await eventStore.loadStream("ORD-LOCKED")).toHaveLength(1);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    await eventStore.append({
      streamId: "ORD-LOCKED",
      expectedVersion: 1,
      event: { type: "OrderShipped", shipmentId: "SHIP-AFTER-LOCK" },
    });
    expect(await eventStore.loadStream("ORD-LOCKED")).toHaveLength(2);
  });

  it("bounds statement time while waiting for a row lock", async () => {
    await eventStore.append({
      streamId: "ORD-STATEMENT",
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 100 },
    });

    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM event_streams WHERE stream_id = $1 FOR UPDATE", [
        "ORD-STATEMENT",
      ]);

      const boundedStore = new OrderEventStore(pool, {
        lockTimeoutMs: 1_000,
        statementTimeoutMs: 25,
      });
      let failure: unknown;
      try {
        await boundedStore.append({
          streamId: "ORD-STATEMENT",
          expectedVersion: 1,
          event: { type: "OrderShipped", shipmentId: "SHIP-STATEMENT" },
        });
      } catch (error) {
        failure = error;
      }

      expect(postgresErrorCode(failure)).toBe("57014");
      expect(await eventStore.loadStream("ORD-STATEMENT")).toHaveLength(1);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
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

    const privileges = await pool.query<{
      role_name: string;
      can_read_events: boolean;
      can_insert_events: boolean;
    }>(
      `SELECT
         role_name,
         has_table_privilege(role_name, 'events', 'SELECT') AS can_read_events,
         has_table_privilege(role_name, 'events', 'INSERT') AS can_insert_events
       FROM unnest($1::text[]) AS role_name
       ORDER BY role_name`,
      [["pw_mcp_read", "pw_mcp_write", "pw_projector"]],
    );
    expect(privileges.rows).toEqual([
      { role_name: "pw_mcp_read", can_read_events: true, can_insert_events: false },
      { role_name: "pw_mcp_write", can_read_events: true, can_insert_events: false },
      { role_name: "pw_projector", can_read_events: true, can_insert_events: false },
    ]);
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

  it("allows permanent global-position holes after a rolled-back insert", async () => {
    const duplicateEventId = "11111111-1111-4111-8111-111111111111";
    const deterministicStore = new OrderEventStore(pool, {
      generateEventId: () => duplicateEventId,
    });
    await deterministicStore.append({
      streamId: "ORD-HOLE-1",
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 100 },
    });

    await expect(
      deterministicStore.append({
        streamId: "ORD-HOLE-2",
        expectedVersion: 0,
        event: { type: "OrderPlaced", totalCents: 100 },
      }),
    ).rejects.toMatchObject({ code: "23505" });

    const afterRollback = await eventStore.append({
      streamId: "ORD-HOLE-3",
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 100 },
    });
    expect(afterRollback.globalPosition).toBe("3");
    expect(await eventStore.loadStream("ORD-HOLE-2")).toEqual([]);
  });

  it("can deterministically hold position N uncommitted while N+1 commits", async () => {
    const gateReached = deferred();
    const releaseCommit = deferred();
    let pendingPosition: string | undefined;
    const gatedStore = new OrderEventStore(pool, {
      beforeCommit: async (event) => {
        pendingPosition = event.globalPosition;
        gateReached.resolve();
        await releaseCommit.promise;
      },
    });

    const pendingAppend = gatedStore.append({
      streamId: "ORD-GATED-A",
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 100 },
    });
    await gateReached.promise;

    const committedLaterPosition = await eventStore.append({
      streamId: "ORD-GATED-B",
      expectedVersion: 0,
      event: { type: "OrderPlaced", totalCents: 200 },
    });

    expect(pendingPosition).toBeDefined();
    expect(BigInt(pendingPosition ?? "0")).toBeLessThan(
      BigInt(committedLaterPosition.globalPosition),
    );
    expect(await eventStore.loadStream("ORD-GATED-A")).toEqual([]);
    expect(await eventStore.loadStream("ORD-GATED-B")).toHaveLength(1);

    releaseCommit.resolve();
    const committedEarlierPosition = await pendingAppend;
    expect(committedEarlierPosition.globalPosition).toBe(pendingPosition);
    expect(await eventStore.loadStream("ORD-GATED-A")).toHaveLength(1);
  });
});
