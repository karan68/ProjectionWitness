import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const MaximumCheckpointBytes = 16_384;
const MaximumTurnEvents = 10_000;

export const TurnCheckpointSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    turnId: z.string().min(1).max(256),
    lastSequenceNumber: z.number().int().nonnegative().safe(),
  })
  .strict();

export type TurnCheckpoint = z.infer<typeof TurnCheckpointSchema>;

const TurnEventSchema = z.object({ type: z.string().min(1).max(128) }).passthrough();
const StreamEventSchema = z
  .object({
    data: z.unknown(),
    id: z.string().regex(/^[1-9][0-9]*$/),
  })
  .passthrough();
const TurnStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running") }).passthrough(),
  z.object({ status: z.literal("done") }).passthrough(),
  z.object({ status: z.literal("cancelled") }).passthrough(),
  z.object({ status: z.literal("error") }).passthrough(),
]);

interface TrueForgeTurnStream extends AsyncIterable<unknown> {
  withMetadata(): AsyncIterable<{ data: unknown; id?: string }>;
}

interface TrueForgeTurnClient {
  sessions: {
    getTurn(sessionId: string, turnId: string): Promise<{ data: { state: unknown } }>;
    subscribeToTurn(
      sessionId: string,
      turnId: string,
      request: { afterSequenceNumber: number },
    ): Promise<TrueForgeTurnStream>;
    listTurnEvents(
      sessionId: string,
      turnId: string,
      request: { limit: number; order: "asc" },
    ): Promise<AsyncIterable<unknown>>;
  };
}

interface TrueForgeSessionTurnClient extends TrueForgeTurnClient {
  sessions: TrueForgeTurnClient["sessions"] & {
    create(request: { agent: { name: string } }): Promise<{ data: { id: string } }>;
    createTurn(
      sessionId: string,
      request: {
        input: Array<{ type: "user.message"; content: string }>;
        previousTurnId: "none";
      },
    ): Promise<{ data: { id: string } }>;
  };
}

export async function readTurnCheckpoint(checkpointPath: string): Promise<TurnCheckpoint> {
  const checkpointStats = await stat(checkpointPath);
  if (!checkpointStats.isFile() || checkpointStats.size > MaximumCheckpointBytes) {
    throw new Error("TrueForge checkpoint must be a file no larger than 16384 bytes");
  }
  return TurnCheckpointSchema.parse(JSON.parse(await readFile(checkpointPath, "utf8")));
}

export async function writeTurnCheckpoint(
  checkpointPath: string,
  input: TurnCheckpoint,
): Promise<void> {
  const checkpoint = TurnCheckpointSchema.parse(input);
  await mkdir(dirname(checkpointPath), { recursive: true });
  const temporaryPath = `${checkpointPath}.${String(process.pid)}.${randomUUID()}.tmp`;
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    await temporaryFile.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, checkpointPath);
  } catch (error) {
    await temporaryFile?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function consumeTurnStream(
  stream: TrueForgeTurnStream,
  inputCheckpoint: TurnCheckpoint,
  persist: (checkpoint: TurnCheckpoint) => Promise<void>,
  onEvent: (event: z.infer<typeof TurnEventSchema>) => Promise<void> = async () => undefined,
): Promise<TurnCheckpoint> {
  let checkpoint = TurnCheckpointSchema.parse(inputCheckpoint);
  let consumed = 0;
  for await (const inputEvent of stream.withMetadata()) {
    consumed += 1;
    if (consumed > MaximumTurnEvents) {
      throw new Error("TrueForge turn stream exceeds the event limit");
    }
    const streamEvent = StreamEventSchema.parse(inputEvent);
    const sequenceNumber = Number(streamEvent.id);
    if (
      !Number.isSafeInteger(sequenceNumber) ||
      sequenceNumber !== checkpoint.lastSequenceNumber + 1
    ) {
      throw new Error("TrueForge turn stream sequence is not contiguous");
    }
    const event = TurnEventSchema.parse(streamEvent.data);
    await onEvent(event);
    checkpoint = TurnCheckpointSchema.parse({
      ...checkpoint,
      lastSequenceNumber: sequenceNumber,
    });
    await persist(checkpoint);
  }
  return checkpoint;
}

export async function startTurn(
  client: TrueForgeSessionTurnClient,
  agentNameInput: string,
  promptInput: string,
  persist: (checkpoint: TurnCheckpoint) => Promise<void>,
  onEvent: (event: z.infer<typeof TurnEventSchema>) => Promise<void> = async () => undefined,
): Promise<TurnCheckpoint> {
  const agentName = z.string().trim().min(1).max(128).parse(agentNameInput);
  const prompt = z.string().trim().min(1).max(32_768).parse(promptInput);
  const session = await client.sessions.create({ agent: { name: agentName } });
  const turn = await client.sessions.createTurn(session.data.id, {
    input: [{ type: "user.message", content: prompt }],
    previousTurnId: "none",
  });
  const checkpoint = TurnCheckpointSchema.parse({
    sessionId: session.data.id,
    turnId: turn.data.id,
    lastSequenceNumber: 0,
  });
  await persist(checkpoint);
  const stream = await client.sessions.subscribeToTurn(checkpoint.sessionId, checkpoint.turnId, {
    afterSequenceNumber: 0,
  });
  return consumeTurnStream(stream, checkpoint, persist, onEvent);
}

export async function collectPersistedTurnEvents(
  input: AsyncIterable<unknown>,
): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of input) {
    if (events.length >= MaximumTurnEvents) {
      throw new Error("Persisted TrueForge turn exceeds the event limit");
    }
    events.push(TurnEventSchema.parse(event));
  }
  return events;
}

export async function reconnectTurn(
  client: TrueForgeTurnClient,
  inputCheckpoint: TurnCheckpoint,
  persist: (checkpoint: TurnCheckpoint) => Promise<void>,
  onEvent: (event: z.infer<typeof TurnEventSchema>) => Promise<void> = async () => undefined,
) {
  const checkpoint = TurnCheckpointSchema.parse(inputCheckpoint);
  const turn = await client.sessions.getTurn(checkpoint.sessionId, checkpoint.turnId);
  const state = TurnStateSchema.parse(turn.data.state);
  if (state.status === "running") {
    const stream = await client.sessions.subscribeToTurn(checkpoint.sessionId, checkpoint.turnId, {
      afterSequenceNumber: checkpoint.lastSequenceNumber,
    });
    const resumedCheckpoint = await consumeTurnStream(stream, checkpoint, persist, onEvent);
    return { mode: "subscribed" as const, checkpoint: resumedCheckpoint, events: [] };
  }

  const events = await collectPersistedTurnEvents(
    await client.sessions.listTurnEvents(checkpoint.sessionId, checkpoint.turnId, {
      limit: 100,
      order: "asc",
    }),
  );
  await persist(checkpoint);
  return { mode: "persisted" as const, checkpoint, events, state };
}
