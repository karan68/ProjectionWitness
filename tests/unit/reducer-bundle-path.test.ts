import { resolveReducerBundlePath } from "@projection-witness/projector";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "projection-witness-path-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "packages", "reducer", "dist"), { recursive: true });
  await mkdir(join(root, "artifacts"), { recursive: true });
  await writeFile(join(root, "packages", "reducer", "dist", "reduce-order.js"), "export {};");
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
  it.each([
    "packages/reducer/dist/reduce-order.js",
    "artifacts/order-reducer.mjs",
    ".\\artifacts\\order-reducer.mjs",
  ])("accepts the known regular artifact %s", async (input) => {
    const root = await projectFixture();
    await expect(resolveReducerBundlePath(input, root)).resolves.toMatch(
      /(?:reduce-order\.js|order-reducer\.mjs)$/,
    );
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
});
