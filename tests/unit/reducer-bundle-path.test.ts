import {
  assertRegularReducerBundle,
  loadReducerBundle,
  resolveReducerBundlePath,
} from "@projection-witness/projector";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("keeps executing the hashed bytes when the artifact path changes after loading", async () => {
    const replacement = "module.exports.reduceOrder = () => { throw new Error('replacement'); };";
    const source = `module.exports.reduceOrder = function (state, event) {
  return state ?? { orderId: event.streamId, totalCents: event.totalCents, paidCents: 0, paymentStatus: "AWAITING_PAYMENT", fulfillmentStatus: "NOT_SHIPPED", lastStreamVersion: event.streamVersion };
};`;
    const fixture = await projectFixture(source);

    const loaded = await loadReducerBundle(fixture.relativePath, fixture.root);
    await writeFile(fixture.artifactPath, replacement);
    expect(loaded.sha256).toBe(fixture.sha256);
    expect(
      loaded.reduceOrder(null, {
        type: "OrderPlaced",
        streamId: "ORD-LOADED",
        streamVersion: 1,
        totalCents: 100,
      }),
    ).toMatchObject({ orderId: "ORD-LOADED", totalCents: 100 });
    expect(await readFile(fixture.artifactPath, "utf8")).toBe(replacement);
  });

  it("redacts bundle source from evaluation and reducer failures", async () => {
    const importFailure = await projectFixture("throw new Error('PRIVATE_IMPORT_SOURCE');");
    await expect(loadReducerBundle(importFailure.relativePath, importFailure.root)).rejects.toThrow(
      "REDUCER_BUNDLE_PATH could not be evaluated safely",
    );

    const reducerFailure = await projectFixture(
      "module.exports.reduceOrder = () => { throw new Error('PRIVATE_REDUCER_SOURCE'); };",
    );
    const loaded = await loadReducerBundle(reducerFailure.relativePath, reducerFailure.root);
    expect(() =>
      loaded.reduceOrder(null, {
        type: "OrderPlaced",
        streamId: "ORD-REDACTED",
        streamVersion: 1,
        totalCents: 100,
      }),
    ).toThrow("Attested reducer execution failed");
  });

  it("rejects bytes that do not match the content-addressed filename", async () => {
    const fixture = await projectFixture();
    await writeFile(fixture.artifactPath, "module.exports = { changed: true };");
    await expect(loadReducerBundle(fixture.relativePath, fixture.root)).rejects.toThrow(
      /filename does not match/,
    );
  });
});
