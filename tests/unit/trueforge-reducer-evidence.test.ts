import {
  collectPersistedSessionEvents,
  verifyTrueForgeReducerEvidence,
} from "../../scripts/lib/verify-trueforge-reducer-evidence.js";
import {
  buildTrueForgeDaytonaEvidenceCommand,
  DaytonaNodeArchiveName,
  DaytonaNodeArchiveSha256,
} from "../../scripts/lib/trueforge-daytona-command.js";
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
  it("binds the official tar.gz archive to its matching SHA-256", () => {
    const built = buildTrueForgeDaytonaEvidenceCommand("d".repeat(40), "e".repeat(64));
    expect(DaytonaNodeArchiveName).toBe("node-v22.23.2-linux-x64.tar.gz");
    expect(DaytonaNodeArchiveSha256).toBe(
      "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a",
    );
    expect(built).toContain(`${DaytonaNodeArchiveSha256}' '${DaytonaNodeArchiveName}`);
    expect(built).toContain(`tar -xzf ${DaytonaNodeArchiveName}`);
    expect(built).toContain("timeout 55s npm ci --include=dev --no-audit --no-fund --silent");
    expect(
      built.match(/timeout 20s curl .*--connect-timeout 10 --max-time 10 --retry-max-time 18/g),
    ).toHaveLength(2);
    expect(built).toContain("timeout 25s npm install --global npm@10.9.9");
    expect(built).toContain("timeout 15s npm run --silent build:reducer");
    expect(built).toContain("timeout 10s npm run --silent evidence:run-reducer");
    expect(built).toContain("https://codeload.github.com/karan68/ProjectionWitness/tar.gz/");
    expect(built).toContain("stage=node-bootstrap-ok");
    expect(built).toContain("stage=reducer-digest-ok");
  });

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

  it("collects every persisted page so an additional tool call cannot be hidden", async () => {
    async function* paginatedItems() {
      for (const event of persistedEvents()) {
        yield { event };
      }
      yield {
        event: {
          type: "model.message",
          toolCalls: [
            {
              id: "hidden-call",
              type: "function",
              function: { name: "exec", arguments: JSON.stringify({ command }) },
              toolInfo: { type: "truefoundry-system", name: "exec" },
            },
          ],
        },
      };
    }

    const allEvents = await collectPersistedSessionEvents(paginatedItems());
    expect(() => verifyTrueForgeReducerEvidence(allEvents, expected)).toThrow(/exactly one/);
  });

  it("rejects oversized persisted text and event counts", async () => {
    const oversizedArguments = persistedEvents();
    const modelMessage = oversizedArguments.find((event) => event.type === "model.message");
    if (modelMessage === undefined || !("toolCalls" in modelMessage)) {
      throw new Error("Test model message is missing");
    }
    const firstToolCall = modelMessage.toolCalls[0];
    if (firstToolCall === undefined) {
      throw new Error("Test tool call is missing");
    }
    firstToolCall.function.arguments = "x".repeat(131_073);
    expect(() => verifyTrueForgeReducerEvidence(oversizedArguments, expected)).toThrow();

    async function* tooManyItems() {
      for (let index = 0; index <= 1_000; index += 1) {
        yield { event: { type: "model.message", index } };
      }
    }
    await expect(collectPersistedSessionEvents(tooManyItems())).rejects.toThrow(/event count/);
  });
});
