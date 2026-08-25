import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ReducerBundleResult {
  outputPath: string;
  byteLength: number;
  sha256: string;
}

export async function buildReducerBundle(
  outputPathInput = "artifacts/order-reducer.mjs",
): Promise<ReducerBundleResult> {
  const outputPath = resolve(outputPathInput);
  const result = await build({
    absWorkingDir: process.cwd(),
    bundle: true,
    charset: "utf8",
    define: { "process.env.NODE_ENV": '"production"' },
    entryPoints: ["packages/reducer/src/index.ts"],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    minify: false,
    outfile: outputPath,
    platform: "node",
    sourcemap: false,
    target: "node22.23",
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles[0];
  if (output === undefined || result.outputFiles.length !== 1) {
    throw new Error("Reducer bundling did not produce exactly one artifact");
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output.contents);
  return {
    outputPath,
    byteLength: output.contents.byteLength,
    sha256: createHash("sha256").update(output.contents).digest("hex"),
  };
}
