import {
  collectPersistedSessionEvents,
  verifyTrueForgeReducerEvidence,
} from "../../scripts/lib/verify-trueforge-reducer-evidence.js";
import {
  buildBoundedNpmCiCommand,
  buildTrueForgeDaytonaEvidenceCommand,
  DaytonaNodeArchiveName,
  DaytonaNodeArchiveSha256,
} from "../../scripts/lib/trueforge-daytona-command.js";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

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
    expect(built).toContain("timeout 80s sh -c 'for attempt in 1 2; do timeout 35s npm ci");
    expect(built).toContain("npm ci --include=dev --no-audit --no-fund --loglevel warn");
    expect(built).toContain("--fetch-retries 2");
    expect(built).toContain("rm -rf node_modules; done; exit 1'");
    expect(
      built.match(/timeout 15s curl .*--connect-timeout 8 --max-time 8 --retry-max-time 13/g),
    ).toHaveLength(2);
    expect(built).toContain("timeout 15s npm install --global npm@10.9.9");
    expect(built).toContain("timeout 10s npm run --silent build:reducer");
    expect(built).toContain("timeout 5s npm run --silent evidence:run-reducer");
    expect(built).toContain("https://codeload.github.com/karan68/ProjectionWitness/tar.gz/");
    expect(built).toContain("stage=node-bootstrap-ok");
    expect(built).toContain("stage=reducer-digest-ok");
  });

  it("times out a stalled install and executes the second attempt", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "projection-witness-npm-retry-"));
    const binaryDirectory = join(temporaryDirectory, "bin");
    const countPath = join(temporaryDirectory, "attempt-count");
    const npmPath = join(binaryDirectory, "npm");
    const shellPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\sh.exe" : "sh";
    await mkdir(binaryDirectory);
    await writeFile(
      npmPath,
      `#!/bin/sh
count=0
test ! -f "$PW_RETRY_COUNT_FILE" || count="$(cat "$PW_RETRY_COUNT_FILE")"
count=$((count + 1))
printf '%s' "$count" > "$PW_RETRY_COUNT_FILE"
test "$count" -ne 1 || sleep 2
test "$count" -eq 2
`,
    );
    await chmod(npmPath, 0o755);

    try {
      const startedAt = Date.now();
      await execFileAsync(shellPath, ["-c", buildBoundedNpmCiCommand(5, 1)], {
        cwd: temporaryDirectory,
        env: {
          ...process.env,
          PATH: `${binaryDirectory}${delimiter}${process.env.PATH ?? ""}`,
          PW_RETRY_COUNT_FILE: countPath,
        },
      });
      expect(await readFile(countPath, "utf8")).toBe("2");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
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
