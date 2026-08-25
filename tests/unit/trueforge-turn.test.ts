import {
  consumeTurnStream,
  readTurnCheckpoint,
  reconnectTurn,
  startTurn,
  type TurnCheckpoint,
  writeTurnCheckpoint,
} from "../../scripts/lib/trueforge-turn.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

async function temporaryCheckpointPath() {
  const directory = await mkdtemp(join(tmpdir(), "projection-witness-turn-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "turn.json");
}

async function* events(...types: string[]) {
  for (const type of types) {
    yield { type };
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("TrueForge turn reconnect", () => {
  it("atomically persists and reads a bounded checkpoint", async () => {
    const checkpointPath = await temporaryCheckpointPath();
    const checkpoint = { sessionId: "session-1", turnId: "turn-1", lastSequenceNumber: 7 };

    await writeTurnCheckpoint(checkpointPath, checkpoint);
    await expect(readTurnCheckpoint(checkpointPath)).resolves.toEqual(checkpoint);
  });

  it("advances and persists one contiguous cursor per streamed event", async () => {
    const persisted: TurnCheckpoint[] = [];
    const persist = vi.fn(async (checkpoint: TurnCheckpoint) => {
      persisted.push(checkpoint);
    });
    const onEvent = vi.fn(async () => undefined);
    const result = await consumeTurnStream(
      events("turn.created", "model.message", "turn.done"),
      { sessionId: "session-1", turnId: "turn-1", lastSequenceNumber: 0 },
      persist,
      onEvent,
    );

    expect(result.lastSequenceNumber).toBe(3);
    expect(persisted.map((checkpoint) => checkpoint.lastSequenceNumber)).toEqual([1, 2, 3]);
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it("creates one identified turn before subscribing from cursor zero", async () => {
    const subscribeToTurn = vi.fn(async () => events("turn.created", "turn.done"));
    const client = {
      sessions: {
        create: vi.fn(async () => ({ data: { id: "session-1" } })),
        createTurn: vi.fn(async () => ({ data: { id: "turn-1" } })),
        subscribeToTurn,
        getTurn: vi.fn(),
        listTurnEvents: vi.fn(),
      },
    };
    const persisted: TurnCheckpoint[] = [];

    const result = await startTurn(
      client,
      "projection-witness",
      "Investigate ORD-1",
      async (next) => {
        persisted.push(next);
      },
    );

    expect(client.sessions.createTurn).toHaveBeenCalledWith("session-1", {
      input: [{ type: "user.message", content: "Investigate ORD-1" }],
      previousTurnId: "none",
    });
    expect(subscribeToTurn).toHaveBeenCalledWith("session-1", "turn-1", {
      afterSequenceNumber: 0,
    });
    expect(persisted.map((item) => item.lastSequenceNumber)).toEqual([0, 1, 2]);
    expect(result.lastSequenceNumber).toBe(2);
  });

  it("resubscribes to a running turn after the exclusive saved cursor", async () => {
    const subscribeToTurn = vi.fn(async () => events("model.message", "turn.done"));
    const listTurnEvents = vi.fn(async () => events());
    const client = {
      sessions: {
        getTurn: vi.fn(async () => ({ data: { state: { status: "running" } } })),
        subscribeToTurn,
        listTurnEvents,
      },
    };

    const result = await reconnectTurn(
      client,
      { sessionId: "session-1", turnId: "turn-1", lastSequenceNumber: 7 },
      async () => undefined,
    );

    expect(result).toMatchObject({ mode: "subscribed", checkpoint: { lastSequenceNumber: 9 } });
    expect(subscribeToTurn).toHaveBeenCalledWith("session-1", "turn-1", {
      afterSequenceNumber: 7,
    });
    expect(listTurnEvents).not.toHaveBeenCalled();
  });

  it("rebuilds a completed turn from persisted events without subscribing or creating a turn", async () => {
    const subscribeToTurn = vi.fn(async () => events());
    const listTurnEvents = vi.fn(async () => events("turn.created", "model.message", "turn.done"));
    const client = {
      sessions: {
        getTurn: vi.fn(async () => ({
          data: { state: { status: "done", requiredActions: [], output: null } },
        })),
        subscribeToTurn,
        listTurnEvents,
      },
    };

    const result = await reconnectTurn(
      client,
      { sessionId: "session-1", turnId: "turn-1", lastSequenceNumber: 7 },
      async () => undefined,
    );

    expect(result).toMatchObject({ mode: "persisted" });
    expect(result.events.map((event) => (event as { type: string }).type)).toEqual([
      "turn.created",
      "model.message",
      "turn.done",
    ]);
    expect(listTurnEvents).toHaveBeenCalledWith("session-1", "turn-1", {
      limit: 100,
      order: "asc",
    });
    expect(subscribeToTurn).not.toHaveBeenCalled();
  });
});
