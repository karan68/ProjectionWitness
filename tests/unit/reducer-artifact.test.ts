import {
  runReducerArtifactEvidence,
  sha256File,
  type CanonicalOrderEvent,
} from "@projection-witness/evidence";
import { buildReducerBundle } from "../../scripts/lib/reducer-bundle.js";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "projection-witness-reducer-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const events: readonly CanonicalOrderEvent[] = [
  {
    eventId: "40000000-0000-4000-8000-000000000001",
    globalPosition: "10",
    streamId: "ORD-DAYTONA",
    streamVersion: 1,
    eventType: "OrderPlaced",
    payload: { type: "OrderPlaced", totalCents: 2500 },
    metadata: {},
    recordedAt: "2026-08-26T02:00:00.000Z",
  },
  {
    eventId: "40000000-0000-4000-8000-000000000002",
    globalPosition: "12",
    streamId: "ORD-DAYTONA",
    streamVersion: 2,
    eventType: "PaymentCaptured",
    payload: { type: "PaymentCaptured", paymentId: "PAY-DAYTONA", amountCents: 2500 },
    metadata: {},
    recordedAt: "2026-08-26T02:00:01.000Z",
  },
];

describe("exact reducer artifact evidence", () => {
  it("builds byte-identical bundles and executes the attested bytes twice", async () => {
    const directory = await temporaryDirectory();
    const first = await buildReducerBundle(join(directory, "first.mjs"));
    const second = await buildReducerBundle(join(directory, "second.mjs"));

    expect(first.sha256).toBe(second.sha256);
    expect(first.sha256).toBe("ec1c540fb4f2f9ececf20cdd14ce9c3f6d255074daadbb9d6056498aa2cd1bc6");
    expect(await readFile(first.outputPath)).toEqual(await readFile(second.outputPath));
    const result = await runReducerArtifactEvidence(first.outputPath, {
      schemaVersion: 1,
      expectedReducerSha256: first.sha256,
      streamId: "ORD-DAYTONA",
      headVersion: 2,
      events,
    });
    expect(result.reducerSha256).toBe(first.sha256);
    expect(result.reducerDeterministic).toBe(true);
    expect(result.candidate.value).toMatchObject({
      orderId: "ORD-DAYTONA",
      paidCents: "2500",
      paymentStatus: "PAID",
      lastStreamVersion: 2,
    });
  });

  it("refuses a digest mismatch before importing the artifact", async () => {
    const directory = await temporaryDirectory();
    const markerPath = join(directory, "imported.txt");
    const artifactPath = join(directory, "untrusted.mjs");
    await writeFile(
      artifactPath,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "executed");\nexport function reduceOrder() { throw new Error("not reached"); }\n`,
    );
    const actualDigest = await sha256File(artifactPath);

    await expect(
      runReducerArtifactEvidence(artifactPath, {
        schemaVersion: 1,
        expectedReducerSha256: actualDigest === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64),
        streamId: "ORD-DAYTONA",
        headVersion: 2,
        events,
      }),
    ).rejects.toThrow(/does not match runtime attestation/);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
