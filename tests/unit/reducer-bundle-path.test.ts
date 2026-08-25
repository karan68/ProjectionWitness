import {
  ApprovedOrderReducerSha256,
  assertRegularReducerBundle,
  loadReducerBundle,
  resolveReducerBundlePath,
} from "@projection-witness/projector";
import {
  executeReducerSource,
  validateDeterministicReducerResults,
} from "../../apps/projector/src/reducer-bundle-path.js";
import { buildReducerBundle } from "../../scripts/lib/reducer-bundle.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

async function projectFixture(source = "module.exports = {};") {
  const root = await mkdtemp(join(tmpdir(), "projection-witness-path-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "artifacts"), { recursive: true });
  const sha256 = createHash("sha256").update(source).digest("hex");
  const relativePath = `artifacts/order-reducer.${sha256}.cjs`;
  const artifactPath = join(root, relativePath);
  await writeFile(artifactPath, source);
  return { artifactPath, relativePath, root, sha256 };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("reducer bundle path", () => {
  it("accepts a content-addressed regular artifact", async () => {
    const fixture = await projectFixture();
    await expect(resolveReducerBundlePath(fixture.relativePath, fixture.root)).resolves.toBe(
      fixture.artifactPath,
    );
    await expect(
      resolveReducerBundlePath(`.\\${fixture.relativePath.replaceAll("/", "\\")}`, fixture.root),
    ).resolves.toBe(fixture.artifactPath);
  });

  it("rejects a symbolic link at the allow-listed path", () => {
    expect(() =>
      assertRegularReducerBundle({
        isFile: () => true,
        isSymbolicLink: () => true,
      }),
    ).toThrow(/symbolic link/);
  });

  it.each([
    "../outside.mjs",
    "scripts/run-naive-v1.ts",
    "artifacts/other.mjs",
    "C:/tmp/order-reducer.cjs",
  ])("rejects an unapproved path %s", async (input) => {
    const fixture = await projectFixture();
    await expect(resolveReducerBundlePath(input, fixture.root)).rejects.toThrow();
  });

  it("rejects a missing allow-listed artifact", async () => {
    const fixture = await projectFixture();
    await rm(fixture.artifactPath);
    await expect(resolveReducerBundlePath(fixture.relativePath, fixture.root)).rejects.toThrow();
  });

  it("loads only the compile-time approved artifact and returns schema-valid output", async () => {
    const bundle = await buildReducerBundle();
    expect(bundle.sha256).toBe(ApprovedOrderReducerSha256);
    const bundlePath = relative(process.cwd(), bundle.outputPath).replaceAll("\\", "/");
    const loaded = await loadReducerBundle(bundlePath);

    await expect(
      loaded.reduceOrder(null, {
        type: "OrderPlaced",
        streamId: "ORD-LOADED",
        streamVersion: 1,
        totalCents: 100,
      }),
    ).resolves.toMatchObject({ orderId: "ORD-LOADED", totalCents: 100 });
  });

  it("rejects a valid content-addressed artifact that is not approved", async () => {
    const source = `module.exports.reduceOrder = function (state, event) {
  return state ?? { orderId: event.streamId, totalCents: event.totalCents, paidCents: 0, paymentStatus: "AWAITING_PAYMENT", fulfillmentStatus: "NOT_SHIPPED", lastStreamVersion: event.streamVersion };
};`;
    const fixture = await projectFixture(source);

    await expect(loadReducerBundle(fixture.relativePath, fixture.root)).rejects.toThrow(
      /not approved/,
    );
  });

  it("redacts worker failures and terminates looping reducer code", async () => {
    await expect(
      executeReducerSource("throw new Error('PRIVATE_IMPORT_SOURCE');", { type: "probe" }),
    ).rejects.toThrow("Attested reducer execution failed");
    await expect(
      executeReducerSource(
        "module.exports.reduceOrder = () => { while (true) {} };",
        {
          type: "reduce",
          state: null,
          event: {
            type: "OrderPlaced",
            streamId: "ORD-TIMEOUT",
            streamVersion: 1,
            totalCents: 100,
          },
        },
        100,
      ),
    ).rejects.toThrow(/timed out/);
  });

  it("awaits asynchronous reducer implementations", async () => {
    const result = await executeReducerSource(
      `module.exports.reduceOrder = async (state, event) => state ?? {
  orderId: event.streamId,
  totalCents: event.totalCents,
  paidCents: 0,
  paymentStatus: "AWAITING_PAYMENT",
  fulfillmentStatus: "NOT_SHIPPED",
  lastStreamVersion: event.streamVersion,
};`,
      {
        type: "reduce",
        state: null,
        event: {
          type: "OrderPlaced",
          streamId: "ORD-ASYNC",
          streamVersion: 1,
          totalCents: 100,
        },
      },
    );
    expect(result).toBeDefined();
    expect(
      validateDeterministicReducerResults(result ?? { first: null, second: null }),
    ).toMatchObject({ orderId: "ORD-ASYNC" });
  });

  it("detects nondeterministic state chosen during module initialization", async () => {
    const result = await executeReducerSource(
      `const chosen = __projectionWitnessReplayPass;
module.exports.reduceOrder = (state, event) => state ?? {
  orderId: event.streamId,
  totalCents: event.totalCents,
  paidCents: chosen,
  paymentStatus: "AWAITING_PAYMENT",
  fulfillmentStatus: "NOT_SHIPPED",
  lastStreamVersion: event.streamVersion,
};`,
      {
        type: "reduce",
        state: null,
        event: {
          type: "OrderPlaced",
          streamId: "ORD-MODULE-STATE",
          streamVersion: 1,
          totalCents: 100,
        },
      },
    );
    expect(() =>
      validateDeterministicReducerResults(result ?? { first: null, second: null }),
    ).toThrow();
  });

  it("rejects invalid or nondeterministic worker output", () => {
    expect(() => validateDeterministicReducerResults({ first: {}, second: {} })).toThrow();
    expect(() =>
      validateDeterministicReducerResults({
        first: {
          orderId: "ORD-NONDETERMINISTIC",
          totalCents: 100,
          paidCents: 0,
          paymentStatus: "AWAITING_PAYMENT",
          fulfillmentStatus: "NOT_SHIPPED",
          lastStreamVersion: 1,
        },
        second: {
          orderId: "ORD-NONDETERMINISTIC",
          totalCents: 100,
          paidCents: 100,
          paymentStatus: "PAID",
          fulfillmentStatus: "NOT_SHIPPED",
          lastStreamVersion: 1,
        },
      }),
    ).toThrow(/not deterministic/);
  });

  it("rejects an oversized bundle before digest approval or evaluation", async () => {
    const source = " ".repeat(1_048_577);
    const fixture = await projectFixture(source);
    await expect(loadReducerBundle(fixture.relativePath, fixture.root)).rejects.toThrow(
      /1048576 byte limit/,
    );
  });

  it("rejects invalid UTF-8 before artifact approval or evaluation", async () => {
    const root = await mkdtemp(join(tmpdir(), "projection-witness-path-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "artifacts"), { recursive: true });
    const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const relativePath = `artifacts/order-reducer.${sha256}.cjs`;
    await writeFile(join(root, relativePath), bytes);

    await expect(loadReducerBundle(relativePath, root)).rejects.toThrow(/not valid UTF-8/);
  });

  it("rejects bytes that do not match the content-addressed filename", async () => {
    const fixture = await projectFixture();
    await writeFile(fixture.artifactPath, "module.exports = { changed: true };");
    await expect(loadReducerBundle(fixture.relativePath, fixture.root)).rejects.toThrow(
      /filename does not match/,
    );
  });
});
