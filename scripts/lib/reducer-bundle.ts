import { build } from "esbuild";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ReducerBundleResult {
  outputPath: string;
  byteLength: number;
  sha256: string;
}

export interface BuildReducerBundleOptions {
  projectRoot?: string;
}

export async function buildReducerBundle(
  options: BuildReducerBundleOptions = {},
): Promise<ReducerBundleResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const result = await build({
    absWorkingDir: projectRoot,
    bundle: true,
    charset: "utf8",
    define: { "process.env.NODE_ENV": '"production"' },
    entryPoints: ["packages/reducer/src/index.ts"],
    format: "cjs",
    legalComments: "none",
    logLevel: "silent",
    minify: false,
    outfile: resolve(projectRoot, "artifacts/order-reducer.cjs"),
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
  const sha256 = createHash("sha256").update(output.contents).digest("hex");
  const outputPath = resolve(projectRoot, `artifacts/order-reducer.${sha256}.cjs`);
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    const existing = await readFile(outputPath);
    if (createHash("sha256").update(existing).digest("hex") !== sha256) {
      throw new Error("Content-addressed reducer artifact contains unexpected bytes");
    }
    return { outputPath, byteLength: existing.byteLength, sha256 };
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }

  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    const temporaryFile = await open(temporaryPath, "wx", 0o600);
    try {
      await temporaryFile.writeFile(output.contents);
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }
    try {
      await rename(temporaryPath, outputPath);
    } catch (error) {
      const existing = await readFile(outputPath).catch(() => undefined);
      if (
        existing === undefined ||
        createHash("sha256").update(existing).digest("hex") !== sha256
      ) {
        throw error;
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return {
    outputPath,
    byteLength: output.contents.byteLength,
    sha256,
  };
}
