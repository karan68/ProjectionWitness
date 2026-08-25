import { buildReducerBundle } from "../../scripts/lib/reducer-bundle.js";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("reducer bundle publication", () => {
  it("publishes concurrent builds atomically without temporary files", async () => {
    const [first, second] = await Promise.all([buildReducerBundle(), buildReducerBundle()]);
    const published = await readFile(first.outputPath);

    expect(first.outputPath).toBe(second.outputPath);
    expect(first.outputPath).toContain(first.sha256);
    expect(first.sha256).toBe(second.sha256);
    expect(createHash("sha256").update(published).digest("hex")).toBe(first.sha256);
    expect((await readdir("artifacts")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a caller-supplied output path before building", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/build-reducer-bundle.ts", "../unapproved.cjs"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not accept an output path");
  });
});
