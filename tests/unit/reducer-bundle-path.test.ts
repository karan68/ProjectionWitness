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

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "projection-witness-path-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "artifacts"), { recursive: true });
  await writeFile(join(root, "artifacts", "order-reducer.mjs"), "export {};");
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("reducer bundle path", () => {
  it.each(["artifacts/order-reducer.mjs", ".\\artifacts\\order-reducer.mjs"])(
    "accepts the known regular artifact %s",
    async (input) => {
      const root = await projectFixture();
      await expect(resolveReducerBundlePath(input, root)).resolves.toMatch(/order-reducer\.mjs$/);
    },
  );

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
    "C:/tmp/order-reducer.mjs",
  ])("rejects an unapproved path %s", async (input) => {
    const root = await projectFixture();
    await expect(resolveReducerBundlePath(input, root)).rejects.toThrow(/known reducer artifact/);
  });

  it("rejects a missing allow-listed artifact", async () => {
    const root = await projectFixture();
    await rm(join(root, "artifacts", "order-reducer.mjs"));
    await expect(resolveReducerBundlePath("artifacts/order-reducer.mjs", root)).rejects.toThrow();
  });

  it("hashes and executes the same bytes when import-time code replaces the path", async () => {
    const root = await projectFixture();
    const artifactPath = join(root, "artifacts", "order-reducer.mjs");
    const replacement = "export function reduceOrder() { throw new Error('replacement'); }";
    const source = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(artifactPath)}, ${JSON.stringify(replacement)});
export function reduceOrder(state, event) {
  return state ?? { orderId: event.streamId, totalCents: event.totalCents, paidCents: 0, paymentStatus: "AWAITING_PAYMENT", fulfillmentStatus: "NOT_SHIPPED", lastStreamVersion: event.streamVersion };
}`;
    await writeFile(artifactPath, source);

    const loaded = await loadReducerBundle("artifacts/order-reducer.mjs", root);
    expect(loaded.sha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(
      loaded.reduceOrder(null, {
        type: "OrderPlaced",
        streamId: "ORD-LOADED",
        streamVersion: 1,
        totalCents: 100,
      }),
    ).toMatchObject({ orderId: "ORD-LOADED", totalCents: 100 });
    expect(await readFile(artifactPath, "utf8")).toBe(replacement);
  });
});
