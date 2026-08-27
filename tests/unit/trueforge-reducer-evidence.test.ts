import {
  collectPersistedSessionEvents,
  verifyTrueForgeReducerEvidence,
} from "../../scripts/lib/verify-trueforge-reducer-evidence.js";
import {
  buildBoundedNpmCiCommand,
  buildTrueForgeDaytonaEvidenceCommand,
  DaytonaEvidenceScriptName,
  DaytonaEvidenceScriptSha256,
  DaytonaNodeArchiveName,
  DaytonaNodeArchiveSha256,
} from "../../scripts/lib/trueforge-daytona-command.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  it("binds a compact exact-commit script to its SHA-256", async () => {
    const built = buildTrueForgeDaytonaEvidenceCommand("d".repeat(40), "e".repeat(64));
    const evidenceScriptBytes = await readFile(
      new URL("../../scripts/daytona-reducer-evidence.sh", import.meta.url),
    );
    const evidenceScript = evidenceScriptBytes.toString("utf8");
    expect(evidenceScript).toContain("npm ci --include=dev --ignore-scripts");
    expect(createHash("sha256").update(evidenceScriptBytes).digest("hex")).toBe(
      DaytonaEvidenceScriptSha256,
    );
    expect(built.length).toBeLessThan(1_000);
    expect(built).toContain(DaytonaEvidenceScriptSha256);
    expect(built).toContain(`/scripts/${DaytonaEvidenceScriptName}`);
    expect(built).toContain("d".repeat(40));
    expect(built).toContain("e".repeat(64));
    expect(built).not.toContain("npm ci");
    expect(built).not.toContain("\n");
    expect(built).toContain('timeout --kill-after=5s 155s sh "$script"');
    expect(built).toContain('rm -rf "$work" "$script"; exit "$status"');
    expect(DaytonaNodeArchiveName).toBe("node-v22.23.2-linux-x64.tar.gz");
    expect(DaytonaNodeArchiveSha256).toBe(
      "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a",
    );
    expect(evidenceScript).toContain(DaytonaNodeArchiveSha256);
    expect(evidenceScript).toContain(DaytonaNodeArchiveName);
    expect(evidenceScript).toContain(buildBoundedNpmCiCommand());
    expect(evidenceScript).toContain(
      "https://codeload.github.com/karan68/ProjectionWitness/tar.gz/",
    );
    expect(evidenceScript).toContain("stage=node-bootstrap-ok");
    expect(evidenceScript).toContain("stage=reducer-digest-ok");
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
if test "$count" -eq 1; then
  trap '' TERM
  sleep 10
fi
test "$count" -eq 2
`,
    );
    await chmod(npmPath, 0o755);

    try {
      const { PATH: currentPath = "" } = process.env;
      const startedAt = Date.now();
      await execFileAsync(shellPath, ["-c", buildBoundedNpmCiCommand(8, 2, 1)], {
        cwd: temporaryDirectory,
        env: {
          ...process.env,
          PATH: `${binaryDirectory}${delimiter}${currentPath}`,
          PW_RETRY_COUNT_FILE: countPath,
        },
      });
      expect(await readFile(countPath, "utf8")).toBe("2");
      expect(Date.now() - startedAt).toBeLessThan(8_000);
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
