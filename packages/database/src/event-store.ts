import {
  OrderEventDataSchema,
  OrderIdSchema,
  type OrderEventData,
} from "@projection-witness/domain";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { z } from "zod";
import { ExpectedVersionConflictError, InvalidOrderStreamError } from "./errors.js";

const ExpectedVersionSchema = z.number().int().nonnegative().safe();
const JsonValueSchema = z.json();
const MetadataSchema = z.record(z.string(), JsonValueSchema);
const TimeoutSchema = z.number().int().positive().safe();
const LoadLimitSchema = z.number().int().positive().safe();

type JsonValue = z.infer<typeof JsonValueSchema>;

interface StreamRow {
  aggregate_type: string;
  version: number;
}

interface EventRow {
  event_id: string;
  global_position: string;
  stream_id: string;
  stream_version: number;
  event_type: string;
  payload: unknown;
  metadata: unknown;
  recorded_at: Date;
}

export interface StoredOrderEvent {
  eventId: string;
  globalPosition: string;
  streamId: string;
  streamVersion: number;
  eventType: OrderEventData["type"];
  payload: OrderEventData;
  metadata: Readonly<Record<string, JsonValue>>;
  recordedAt: string;
}

export interface AppendOrderEventInput {
  streamId: string;
  expectedVersion: number;
  event: OrderEventData;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface OrderEventStoreOptions {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  generateEventId?: () => string;
  beforeCommit?: (event: StoredOrderEvent) => Promise<void>;
}

function storedEvent(row: EventRow): StoredOrderEvent {
  const payload = OrderEventDataSchema.parse(row.payload);
  if (payload.type !== row.event_type) {
    throw new InvalidOrderStreamError("Stored event type does not match its payload type");
  }

  return {
    eventId: row.event_id,
    globalPosition: row.global_position,
    streamId: row.stream_id,
    streamVersion: row.stream_version,
    eventType: payload.type,
    payload,
    metadata: MetadataSchema.parse(row.metadata),
    recordedAt: row.recorded_at.toISOString(),
  };
}

interface EventQueryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export async function loadOrderStream(
  queryable: EventQueryable,
  streamIdInput: string,
  limitInput?: number,
): Promise<readonly StoredOrderEvent[]> {
  const streamId = OrderIdSchema.parse(streamIdInput);
  const limit = limitInput === undefined ? null : LoadLimitSchema.parse(limitInput);
  const result = await queryable.query<EventRow>(
    `SELECT
       event_id,
       global_position::text,
       stream_id,
       stream_version,
       event_type,
       payload,
       metadata,
       recorded_at
     FROM events
     WHERE stream_id = $1
     ORDER BY stream_version
     LIMIT $2`,
    [streamId, limit],
  );

  return result.rows.map(storedEvent);
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original transaction error remains authoritative.
  }
}

export class OrderEventStore {
  private readonly pool: Pool;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly generateEventId: () => string;
  private readonly beforeCommit: ((event: StoredOrderEvent) => Promise<void>) | undefined;

  constructor(pool: Pool, options: OrderEventStoreOptions = {}) {
    this.pool = pool;
    this.lockTimeoutMs = TimeoutSchema.parse(options.lockTimeoutMs ?? 2_000);
    this.statementTimeoutMs = TimeoutSchema.parse(options.statementTimeoutMs ?? 5_000);
    this.generateEventId = options.generateEventId ?? randomUUID;
    this.beforeCommit = options.beforeCommit;
  }

  async append(input: AppendOrderEventInput): Promise<StoredOrderEvent> {
    const streamId = OrderIdSchema.parse(input.streamId);
    const expectedVersion = ExpectedVersionSchema.parse(input.expectedVersion);
    const event = OrderEventDataSchema.parse(input.event);
    const metadata = MetadataSchema.parse(input.metadata ?? {});
    const eventId = z.uuid().parse(this.generateEventId());
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('lock_timeout', $1, true)", [
        `${String(this.lockTimeoutMs)}ms`,
      ]);
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${String(this.statementTimeoutMs)}ms`,
      ]);

      await client.query(
        `INSERT INTO event_streams (stream_id, aggregate_type, version)
         VALUES ($1, 'Order', 0)
         ON CONFLICT (stream_id) DO NOTHING`,
        [streamId],
      );

      const streamResult = await client.query<StreamRow>(
        `SELECT aggregate_type, version
         FROM event_streams
         WHERE stream_id = $1
         FOR UPDATE`,
        [streamId],
      );
      const stream = streamResult.rows[0];
      if (stream === undefined) {
        throw new Error("Stream row disappeared while appending an event");
      }
      if (stream.aggregate_type !== "Order") {
        throw new InvalidOrderStreamError("Stream aggregate type is not Order");
      }
      if (stream.version !== expectedVersion) {
        throw new ExpectedVersionConflictError(streamId, expectedVersion, stream.version);
      }
      if (stream.version === 0 && event.type !== "OrderPlaced") {
        throw new InvalidOrderStreamError("An order stream must begin with OrderPlaced");
      }
      if (stream.version > 0 && event.type === "OrderPlaced") {
        throw new InvalidOrderStreamError("OrderPlaced may appear only once");
      }

      const streamVersion = stream.version + 1;
      const eventResult = await client.query<EventRow>(
        `INSERT INTO events (
           event_id,
           stream_id,
           stream_version,
           event_type,
           payload,
           metadata
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         RETURNING
           event_id,
           global_position::text,
           stream_id,
           stream_version,
           event_type,
           payload,
           metadata,
           recorded_at`,
        [
          eventId,
          streamId,
          streamVersion,
          event.type,
          JSON.stringify(event),
          JSON.stringify(metadata),
        ],
      );

      const updateResult = await client.query(
        `UPDATE event_streams
         SET version = $2, updated_at = clock_timestamp()
         WHERE stream_id = $1 AND version = $3`,
        [streamId, streamVersion, stream.version],
      );
      if (updateResult.rowCount !== 1) {
        throw new Error("Stream version compare-and-swap affected an unexpected row count");
      }

      const insertedEvent = eventResult.rows[0];
      if (insertedEvent === undefined) {
        throw new Error("Event insert did not return the inserted row");
      }

      const eventToCommit = storedEvent(insertedEvent);
      await this.beforeCommit?.(eventToCommit);
      await client.query("COMMIT");
      return eventToCommit;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadStream(streamIdInput: string): Promise<readonly StoredOrderEvent[]> {
    return loadOrderStream(this.pool, streamIdInput);
  }
}
