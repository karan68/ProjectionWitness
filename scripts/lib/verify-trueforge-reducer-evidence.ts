import { ReducerArtifactEvidenceResultSchema } from "@projection-witness/evidence";
import { z } from "zod";

const ToolCallSchema = z
  .object({
    id: z.string().min(1),
    function: z
      .object({
        name: z.literal("exec"),
        arguments: z.string(),
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
    command: z.string(),
    intent: z.string().optional(),
  })
  .strict();

const ToolResponseContentSchema = z
  .object({
    success: z.literal(true),
    response: z
      .object({
        exitCode: z.literal(0),
        result: z.string(),
      })
      .strict(),
  })
  .strict();

const PersistedToolResponseSchema = z
  .object({
    type: z.literal("tool.response"),
    toolCallId: z.string().min(1),
    content: z.string(),
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

export function verifyTrueForgeReducerEvidence(
  events: readonly unknown[],
  expected: ExpectedTrueForgeReducerEvidence,
) {
  const records = events.map((event) => z.object({ type: z.string() }).passthrough().parse(event));
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
  if (arguments_.command !== expected.command) {
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
    result.reducerSha256 !== expected.reducerSha256 ||
    result.stream.streamId !== expected.streamId ||
    result.stream.sha256 !== expected.streamSha256 ||
    result.candidate.sha256 !== expected.candidateSha256
  ) {
    throw new Error("Reducer evidence result does not match the expected fixture and artifact");
  }
  return result;
}
