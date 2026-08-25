import { verifyTrueForgeReducerEvidence } from "../../scripts/lib/verify-trueforge-reducer-evidence.js";
import { describe, expect, it } from "vitest";

const command = "printf exact-command";
const result = {
  schemaVersion: 1,
  reducerSha256: "a".repeat(64),
  stream: {
    streamId: "ORD-FIXTURE",
    headVersion: 2,
    eventCount: 2,
    firstStreamVersion: 1,
    lastStreamVersion: 2,
    sha256: "b".repeat(64),
    canonicalBytes: 100,
  },
  candidate: {
    value: {
      orderId: "ORD-FIXTURE",
      totalCents: "100",
      paidCents: "100",
      paymentStatus: "PAID",
      fulfillmentStatus: "NOT_SHIPPED",
      lastStreamVersion: 2,
    },
    sha256: "c".repeat(64),
  },
  reducerDeterministic: true,
} as const;

const expected = {
  command,
  reducerSha256: result.reducerSha256,
  streamId: result.stream.streamId,
  streamSha256: result.stream.sha256,
  candidateSha256: result.candidate.sha256,
};

function persistedEvents(overrides?: {
  command?: string;
  exitCode?: number;
  resultText?: string;
  extraToolCall?: boolean;
  responseCallId?: string;
}) {
  const toolCall = {
    id: "call-evidence",
    type: "function",
    function: {
      name: "exec",
      arguments: JSON.stringify({ command: overrides?.command ?? command, intent: "verify" }),
    },
    toolInfo: { type: "truefoundry-system", name: "exec" },
  };
  return [
    { type: "sandbox.created", id: "sandbox-event" },
    {
      type: "model.message",
      toolCalls: overrides?.extraToolCall
        ? [toolCall, { ...toolCall, id: "call-extra" }]
        : [toolCall],
    },
    {
      type: "tool.response",
      toolCallId: overrides?.responseCallId ?? toolCall.id,
      content: JSON.stringify({
        success: true,
        response: {
          exitCode: overrides?.exitCode ?? 0,
          result: overrides?.resultText ?? `build output\n${JSON.stringify(result)}\n`,
        },
      }),
    },
    { type: "turn.done", state: { status: "done" } },
  ];
}

describe("TrueForge reducer evidence verification", () => {
  it("accepts one exact successful exec result", () => {
    expect(verifyTrueForgeReducerEvidence(persistedEvents(), expected)).toEqual(result);
  });

  it("rejects forged substrings that are not a complete structured result", () => {
    expect(() =>
      verifyTrueForgeReducerEvidence(
        persistedEvents({
          resultText: `claimed ${result.reducerSha256} and "reducerDeterministic":true`,
        }),
        expected,
      ),
    ).toThrow();
  });

  it("rejects a changed command, extra tool call, nonzero exit, or mismatched response", () => {
    expect(() =>
      verifyTrueForgeReducerEvidence(persistedEvents({ command: "printf forged" }), expected),
    ).toThrow(/does not match/);
    expect(() =>
      verifyTrueForgeReducerEvidence(persistedEvents({ extraToolCall: true }), expected),
    ).toThrow(/exactly one/);
    expect(() =>
      verifyTrueForgeReducerEvidence(persistedEvents({ exitCode: 1 }), expected),
    ).toThrow();
    expect(() =>
      verifyTrueForgeReducerEvidence(
        persistedEvents({ responseCallId: "different-call" }),
        expected,
      ),
    ).toThrow(/linked/);
  });

  it("rejects a schema-valid result for a different fixture", () => {
    const different = {
      ...result,
      stream: { ...result.stream, streamId: "ORD-OTHER" },
    };
    expect(() =>
      verifyTrueForgeReducerEvidence(
        persistedEvents({ resultText: JSON.stringify(different) }),
        expected,
      ),
    ).toThrow(/expected fixture/);
  });
});
