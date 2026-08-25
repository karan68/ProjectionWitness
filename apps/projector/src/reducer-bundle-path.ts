import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { normalize, resolve } from "node:path";
import { z } from "zod";
import type { OrderReducer } from "./gap-aware-projector.js";

const ReducerBundlePathSchema = z.string().trim().min(1).max(256);
const AllowedReducerBundlePaths = ["artifacts/order-reducer.mjs"] as const;

export interface LoadedReducerBundle {
  reduceOrder: OrderReducer;
  sha256: string;
}

export interface ReducerBundleFileInfo {
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}

function isOrderReducer(value: unknown): value is OrderReducer {
  return typeof value === "function";
}

export function assertRegularReducerBundle(fileInfo: ReducerBundleFileInfo): void {
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new Error("REDUCER_BUNDLE_PATH must identify a regular file, not a symbolic link");
  }
}

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
  assertRegularReducerBundle(fileInfo);
  const resolvedPath = normalize(await realpath(requestedPath));
  if (resolvedPath !== requestedPath) {
    throw new Error("REDUCER_BUNDLE_PATH must resolve directly inside the project");
  }
  return resolvedPath;
}

export async function loadReducerBundle(
  input: string,
  projectRoot = process.cwd(),
): Promise<LoadedReducerBundle> {
  const bundlePath = await resolveReducerBundlePath(input, projectRoot);
  const file = await open(bundlePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const fileInfo = await file.stat();
    if (!fileInfo.isFile()) {
      throw new Error("REDUCER_BUNDLE_PATH must remain a regular file while loading");
    }
    bytes = await file.readFile();
  } finally {
    await file.close();
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dataUrl = `data:text/javascript;base64,${bytes.toString("base64")}`;
  const reducerModule = (await import(dataUrl)) as { reduceOrder?: unknown };
  if (!isOrderReducer(reducerModule.reduceOrder)) {
    throw new Error("REDUCER_BUNDLE_PATH must export reduceOrder");
  }
  return { reduceOrder: reducerModule.reduceOrder, sha256 };
}
