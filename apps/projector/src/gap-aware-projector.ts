import { parseSafeDatabaseInteger } from "@projection-witness/database";
import {
  OrderEventDataSchema,
  OrderProjectionSchema,
  versionOrderEvent,
  type OrderEvent,
  type OrderProjection,
} from "@projection-witness/domain";
import { reduceOrder } from "@projection-witness/reducer";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

const ProjectionNameSchema = z.string().trim().min(1).max(128);
const PositiveIntegerSchema = z.number().int().positive().safe();

interface CheckpointRow {
  last_global_position: string;
}

interface ProjectorEventRow {
  global_position: string;
  stream_id: string;
  stream_version: number;
  event_type: string;
  payload: unknown;
}

interface OrderViewRow {
  order_id: string;
  total_cents: string;
  paid_cents: string;
  payment_status: string;
  fulfillment_status: string;
  last_stream_version: number;
  row_version: string;
}

export type OrderReducer = (
  state: OrderProjection | null,
  event: OrderEvent,
) => OrderProjection | Promise<OrderProjection>;

export interface GapAwareProjectorOptions {
  projectionName?: string;
  batchSize?: number;
  gapBatchSize?: number;
  maxObservedGapSpan?: number;
  gapRetentionDistance?: number;
  gapRetentionMs?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  reducer?: OrderReducer;
}

export interface GapAwareProjectorPollResult {
  projectionName: string;
  processedCount: number;
  checkpointBefore: string;
  checkpointAfter: string;
  processedGlobalPositions: readonly string[];
  trackedGapPositions: readonly string[];
  resolvedGapPositions: readonly string[];
  retiredGapPositions: readonly string[];
}

function projectionFromRow(row: OrderViewRow): OrderProjection {
  return OrderProjectionSchema.parse({
    orderId: row.order_id,
    totalCents: parseSafeDatabaseInteger(row.total_cents, "order_view.total_cents"),
    paidCents: parseSafeDatabaseInteger(row.paid_cents, "order_view.paid_cents"),
    paymentStatus: row.payment_status,
    fulfillmentStatus: row.fulfillment_status,
    lastStreamVersion: row.last_stream_version,
  });
}

function parseEvent(row: ProjectorEventRow): OrderEvent {
  const payload = OrderEventDataSchema.parse(row.payload);
  if (payload.type !== row.event_type) {
    throw new Error("Stored event type does not match its payload type");
  }
  return versionOrderEvent(row.stream_id, row.stream_version, payload);
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original projector failure remains authoritative.
  }
}

export class GapAwareOrderProjector {
  private readonly pool: Pool;
  private readonly projectionName: string;
  private readonly batchSize: number;
  private readonly gapBatchSize: number;
  private readonly maxObservedGapSpan: number;
  private readonly gapRetentionDistance: number;
  private readonly gapRetentionMs: number;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly reducer: OrderReducer;

  constructor(pool: Pool, options: GapAwareProjectorOptions = {}) {
    this.pool = pool;
    this.projectionName = ProjectionNameSchema.parse(options.projectionName ?? "orders");
    this.batchSize = PositiveIntegerSchema.parse(options.batchSize ?? 100);
    this.gapBatchSize = PositiveIntegerSchema.parse(options.gapBatchSize ?? 100);
    this.maxObservedGapSpan = PositiveIntegerSchema.parse(options.maxObservedGapSpan ?? 10_000);
    this.gapRetentionDistance = PositiveIntegerSchema.parse(options.gapRetentionDistance ?? 10_000);
    this.gapRetentionMs = PositiveIntegerSchema.parse(options.gapRetentionMs ?? 300_000);
    this.lockTimeoutMs = PositiveIntegerSchema.parse(options.lockTimeoutMs ?? 2_000);
    this.statementTimeoutMs = PositiveIntegerSchema.parse(options.statementTimeoutMs ?? 5_000);
    this.reducer = options.reducer ?? reduceOrder;
  }

  async poll(): Promise<GapAwareProjectorPollResult> {
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
        `INSERT INTO projection_checkpoints (projection_name, last_global_position)
         VALUES ($1, 0)
         ON CONFLICT (projection_name) DO NOTHING`,
        [this.projectionName],
      );

      const checkpointResult = await client.query<CheckpointRow>(
        `SELECT last_global_position::text
         FROM projection_checkpoints
         WHERE projection_name = $1
         FOR UPDATE`,
        [this.projectionName],
      );
      const checkpoint = checkpointResult.rows[0];
      if (checkpoint === undefined) {
        throw new Error("Projection checkpoint disappeared while polling");
      }

      const visibleGaps = await client.query<ProjectorEventRow>(
        `SELECT
           events.global_position::text,
           events.stream_id,
           events.stream_version,
           events.event_type,
           events.payload
         FROM projection_gaps
         INNER JOIN events USING (global_position)
         LEFT JOIN order_view ON order_view.order_id = events.stream_id
         WHERE projection_gaps.projection_name = $1
           AND (
             (order_view.order_id IS NULL AND events.stream_version = 1)
             OR order_view.last_stream_version >= events.stream_version - 1
           )
         ORDER BY events.global_position
         LIMIT $2`,
        [this.projectionName, this.gapBatchSize],
      );
      const newEvents = await client.query<ProjectorEventRow>(
        `SELECT
           global_position::text,
           stream_id,
           stream_version,
           event_type,
           payload
         FROM events
         WHERE global_position > $1::bigint
         ORDER BY events.global_position
         LIMIT $2`,
        [checkpoint.last_global_position, this.batchSize],
      );

      const trackedGapPositions: string[] = [];
      let priorPosition = BigInt(checkpoint.last_global_position);
      for (const row of newEvents.rows) {
        const position = BigInt(row.global_position);
        const missingCount = position - priorPosition - 1n;
        if (
          missingCount > BigInt(this.maxObservedGapSpan) ||
          BigInt(trackedGapPositions.length) + missingCount > BigInt(this.maxObservedGapSpan)
        ) {
          throw new Error("Observed global-position gap exceeds the configured tracking bound");
        }
        for (let missing = priorPosition + 1n; missing < position; missing += 1n) {
          trackedGapPositions.push(missing.toString());
        }
        priorPosition = position;
      }
      if (trackedGapPositions.length > 0) {
        await client.query(
          `INSERT INTO projection_gaps (projection_name, global_position)
           SELECT $1, unnest($2::bigint[])
           ON CONFLICT (projection_name, global_position) DO NOTHING`,
          [this.projectionName, trackedGapPositions],
        );
      }

      const eventsByPosition = new Map<string, ProjectorEventRow>();
      for (const row of [...visibleGaps.rows, ...newEvents.rows]) {
        eventsByPosition.set(row.global_position, row);
      }
      const orderedEvents = [...eventsByPosition.values()].sort((left, right) => {
        const leftPosition = BigInt(left.global_position);
        const rightPosition = BigInt(right.global_position);
        return leftPosition < rightPosition ? -1 : leftPosition > rightPosition ? 1 : 0;
      });

      const processedGlobalPositions: string[] = [];
      const resolvedGapPositions: string[] = [];
      for (const eventRow of orderedEvents) {
        const applied = await this.applyEvent(client, eventRow);
        if (!applied) {
          await client.query(
            `INSERT INTO projection_gaps (projection_name, global_position)
             VALUES ($1, $2::bigint)
             ON CONFLICT (projection_name, global_position) DO NOTHING`,
            [this.projectionName, eventRow.global_position],
          );
          continue;
        }
        processedGlobalPositions.push(eventRow.global_position);
        const deleted = await client.query(
          `DELETE FROM projection_gaps
           WHERE projection_name = $1 AND global_position = $2::bigint`,
          [this.projectionName, eventRow.global_position],
        );
        if (deleted.rowCount === 1) {
          resolvedGapPositions.push(eventRow.global_position);
        }
      }

      const checkpointAfter =
        newEvents.rows.at(-1)?.global_position ?? checkpoint.last_global_position;
      if (checkpointAfter !== checkpoint.last_global_position) {
        await client.query(
          `UPDATE projection_checkpoints
           SET last_global_position = $2::bigint, updated_at = clock_timestamp()
           WHERE projection_name = $1`,
          [this.projectionName, checkpointAfter],
        );
      }

      const retired = await client.query<{ global_position: string }>(
        `DELETE FROM projection_gaps AS gaps
         WHERE gaps.projection_name = $1
           AND gaps.global_position <= $2::bigint - $3::bigint
           AND gaps.first_observed_at <= clock_timestamp() - ($4::bigint * interval '1 millisecond')
           AND NOT EXISTS (
             SELECT 1 FROM events WHERE events.global_position = gaps.global_position
           )
         RETURNING gaps.global_position::text`,
        [this.projectionName, checkpointAfter, this.gapRetentionDistance, this.gapRetentionMs],
      );

      await client.query("COMMIT");
      return {
        projectionName: this.projectionName,
        processedCount: processedGlobalPositions.length,
        checkpointBefore: checkpoint.last_global_position,
        checkpointAfter,
        processedGlobalPositions,
        trackedGapPositions,
        resolvedGapPositions,
        retiredGapPositions: retired.rows.map((row) => row.global_position),
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async applyEvent(client: PoolClient, eventRow: ProjectorEventRow): Promise<boolean> {
    const event = parseEvent(eventRow);
    const rowResult = await client.query<OrderViewRow>(
      `SELECT
         order_id,
         total_cents::text,
         paid_cents::text,
         payment_status,
         fulfillment_status,
         last_stream_version,
         row_version::text
       FROM order_view
       WHERE order_id = $1
       FOR UPDATE`,
      [event.streamId],
    );
    const currentRow = rowResult.rows[0];
    const currentProjection = currentRow === undefined ? null : projectionFromRow(currentRow);
    if (currentProjection !== null && currentProjection.lastStreamVersion >= event.streamVersion) {
      return true;
    }
    const expectedPriorVersion = currentProjection?.lastStreamVersion ?? 0;
    if (expectedPriorVersion !== event.streamVersion - 1) {
      return false;
    }

    const candidate = await this.reducer(currentProjection, event);
    if (currentRow === undefined) {
      await client.query(
        `INSERT INTO order_view (
           order_id,
           total_cents,
           paid_cents,
           payment_status,
           fulfillment_status,
           last_stream_version
         )
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          candidate.orderId,
          candidate.totalCents,
          candidate.paidCents,
          candidate.paymentStatus,
          candidate.fulfillmentStatus,
          candidate.lastStreamVersion,
        ],
      );
      return true;
    }

    const updateResult = await client.query(
      `UPDATE order_view
       SET total_cents = $2,
           paid_cents = $3,
           payment_status = $4,
           fulfillment_status = $5,
           last_stream_version = $6,
           row_version = row_version + 1,
           updated_at = clock_timestamp()
       WHERE order_id = $1
         AND row_version = $7::bigint
         AND last_stream_version = $8`,
      [
        candidate.orderId,
        candidate.totalCents,
        candidate.paidCents,
        candidate.paymentStatus,
        candidate.fulfillmentStatus,
        candidate.lastStreamVersion,
        currentRow.row_version,
        event.streamVersion - 1,
      ],
    );
    if (updateResult.rowCount !== 1) {
      throw new Error("Projection row compare-and-swap affected an unexpected row count");
    }
    return true;
  }
}
