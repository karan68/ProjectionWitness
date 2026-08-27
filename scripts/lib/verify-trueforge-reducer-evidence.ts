import { ReducerArtifactEvidenceResultSchema } from "@projection-witness/evidence";
import { z } from "zod";

const MaximumPersistedEvents = 1_000;
const MaximumToolArgumentsBytes = 131_072;
const MaximumToolResponseBytes = 2_097_152;
const MaximumCommandBytes = 65_536;
const MaximumResultBytes = 1_048_576;
const MaximumBaseUrlBytes = 2_048;
const EventListingDeadlineMsSchema = z.number().int().positive().max(120_000);

const ToolCallSchema = z
  .object({
    id: z.string().min(1),
    function: z
      .object({
        name: z.literal("exec"),
        arguments: z.string().max(MaximumToolArgumentsBytes),
      })
      .strict(),
    toolInfo: z
      .object({
        type: z.literal("truefoundry-system"),
        name: z.literal("exec"),
      })
      .passthrough(),
  })
  .passthrough();

const ExecArgumentsSchema = z
  .object({
    command: z.string().max(MaximumCommandBytes),
    intent: z.string().max(4_096).optional(),
  })
  .strict();

const ToolResponseContentSchema = z
  .object({
    success: z.literal(true),
    response: z
      .object({
        exitCode: z.literal(0),
        result: z.string().max(MaximumResultBytes),
      })
      .strict(),
  })
  .strict();

const PersistedToolResponseSchema = z
  .object({
    type: z.literal("tool.response"),
    toolCallId: z.string().min(1).max(256),
    content: z.string().max(MaximumToolResponseBytes),
  })
  .passthrough();

const PersistedDoneEventSchema = z
  .object({
    type: z.literal("turn.done"),
    state: z.object({ status: z.literal("done") }).passthrough(),
  })
  .passthrough();

export interface ExpectedTrueForgeReducerEvidence {
  command: string;
  reducerSha256: string;
  streamId: string;
  streamSha256: string;
  candidateSha256: string;
}

export async function collectPersistedSessionEvents(
  items: AsyncIterable<{ event: unknown }>,
): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const item of items) {
    if (events.length >= MaximumPersistedEvents) {
      throw new Error("Persisted TrueForge event count exceeds the verification limit");
    }
    events.push(item.event);
  }
  return events;
}

export function parseLoopbackTrueForgeBaseUrl(input: string): string {
  const value = z.string().trim().min(1).max(MaximumBaseUrlBytes).parse(input);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TRUEFORGE_BASE_URL must be a valid URL");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("TRUEFORGE_BASE_URL must use http or https");
  }
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)) {
    throw new Error("TRUEFORGE_BASE_URL must use a loopback host");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("TRUEFORGE_BASE_URL must contain only a loopback origin");
  }
  return url.origin;
}

export async function collectPersistedSessionEventsWithinDeadline(
  load: (signal: AbortSignal) => Promise<AsyncIterable<{ event: unknown }>>,
  deadlineMsInput = 30_000,
): Promise<unknown[]> {
  const deadlineMs = EventListingDeadlineMsSchema.parse(deadlineMsInput);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("TrueForge event listing exceeded its aggregate deadline")),
    deadlineMs,
  );
  timeout.unref();
  try {
    return await collectPersistedSessionEvents(await load(controller.signal));
  } finally {
    clearTimeout(timeout);
  }
}

export function verifyTrueForgeReducerEvidence(
  events: readonly unknown[],
  expected: ExpectedTrueForgeReducerEvidence,
) {
  const boundedEvents = z.array(z.unknown()).max(MaximumPersistedEvents).parse(events);
  const boundedExpected = z
    .object({
      command: z.string().max(MaximumCommandBytes),
      reducerSha256: z.string().regex(/^[0-9a-f]{64}$/),
      streamId: z.string().min(1).max(128),
      streamSha256: z.string().regex(/^[0-9a-f]{64}$/),
      candidateSha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict()
    .parse(expected);
  const records = boundedEvents.map((event) =>
    z
      .object({ type: z.string().max(128) })
      .passthrough()
      .parse(event),
  );
  const sandboxEvents = records.filter((event) => event.type === "sandbox.created");
  if (sandboxEvents.length !== 1) {
    throw new Error("Expected exactly one persisted sandbox.created event");
  }

  const doneEvents = records
    .filter((event) => event.type === "turn.done")
    .map((event) => PersistedDoneEventSchema.safeParse(event));
  if (doneEvents.length !== 1 || doneEvents[0]?.success !== true) {
    throw new Error("Expected exactly one successfully completed persisted turn");
  }

  const toolCalls = records.flatMap((event) => {
    if (event.type !== "model.message") {
      return [];
    }
    const message = z
      .object({ toolCalls: z.array(z.unknown()).optional() })
      .passthrough()
      .parse(event);
    return message.toolCalls ?? [];
  });
  if (toolCalls.length !== 1) {
    throw new Error("Expected exactly one persisted sandbox tool call");
  }
  const toolCall = ToolCallSchema.parse(toolCalls[0]);
  const arguments_ = ExecArgumentsSchema.parse(JSON.parse(toolCall.function.arguments));
  if (arguments_.command !== boundedExpected.command) {
    throw new Error("Persisted exec command does not match the requested evidence command");
  }

  const responses = records
    .filter((event) => event.type === "tool.response")
    .map((event) => PersistedToolResponseSchema.parse(event));
  if (responses.length !== 1 || responses[0]?.toolCallId !== toolCall.id) {
    throw new Error("Expected one persisted response linked to the exact exec call");
  }
  const response = ToolResponseContentSchema.parse(JSON.parse(responses[0].content));
  const outputLines = response.response.result
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const finalLine = outputLines.at(-1);
  if (finalLine === undefined) {
    throw new Error("Successful exec response did not contain reducer evidence JSON");
  }
  const result = ReducerArtifactEvidenceResultSchema.parse(JSON.parse(finalLine));
  if (
    result.reducerSha256 !== boundedExpected.reducerSha256 ||
    result.stream.streamId !== boundedExpected.streamId ||
    result.stream.sha256 !== boundedExpected.streamSha256 ||
    result.candidate.sha256 !== boundedExpected.candidateSha256
  ) {
    throw new Error("Reducer evidence result does not match the expected fixture and artifact");
  }
  return result;
}
