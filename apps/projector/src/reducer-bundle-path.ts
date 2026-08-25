import { lstat, realpath } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import { z } from "zod";

const ReducerBundlePathSchema = z.string().trim().min(1).max(256);
const AllowedReducerBundlePaths = [
  "packages/reducer/dist/reduce-order.js",
  "artifacts/order-reducer.mjs",
] as const;

export async function resolveReducerBundlePath(
  input: string,
  projectRoot = process.cwd(),
): Promise<string> {
  const parsed = ReducerBundlePathSchema.parse(input).replaceAll("\\", "/");
  const requestedPath = normalize(resolve(projectRoot, parsed));
  const allowedPaths = AllowedReducerBundlePaths.map((relativePath) =>
    normalize(resolve(projectRoot, relativePath)),
  );
  if (!allowedPaths.includes(requestedPath)) {
    throw new Error("REDUCER_BUNDLE_PATH must identify a known reducer artifact");
  }

  const fileInfo = await lstat(requestedPath);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new Error("REDUCER_BUNDLE_PATH must identify a regular file, not a symbolic link");
  }
  const resolvedPath = normalize(await realpath(requestedPath));
  if (resolvedPath !== requestedPath) {
    throw new Error("REDUCER_BUNDLE_PATH must resolve directly inside the project");
  }
  return resolvedPath;
}
