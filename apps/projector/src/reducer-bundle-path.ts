import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { normalize, resolve } from "node:path";
import { createContext, Script } from "node:vm";
import { z } from "zod";
import type { OrderReducer } from "./gap-aware-projector.js";

const ReducerBundlePathSchema = z.string().trim().min(1).max(256);
const ContentAddressedBundlePathSchema = z
  .string()
  .regex(/^artifacts\/order-reducer\.([0-9a-f]{64})\.cjs$/);

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
  const normalizedInput = ReducerBundlePathSchema.parse(input).replaceAll("\\", "/");
  const parsed = normalizedInput.startsWith("./") ? normalizedInput.slice(2) : normalizedInput;
  ContentAddressedBundlePathSchema.parse(parsed);
  const requestedPath = normalize(resolve(projectRoot, parsed));

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
  const filenameDigest = /\.([0-9a-f]{64})\.cjs$/.exec(bundlePath)?.[1];
  if (filenameDigest !== sha256) {
    throw new Error("REDUCER_BUNDLE_PATH filename does not match its SHA-256 digest");
  }
  const module = { exports: {} as { reduceOrder?: unknown } };
  try {
    const context = createContext({ module, exports: module.exports });
    new Script(bytes.toString("utf8"), {
      filename: "projection-witness-order-reducer.cjs",
    }).runInContext(context);
  } catch {
    throw new Error("REDUCER_BUNDLE_PATH could not be evaluated safely");
  }
  if (!isOrderReducer(module.exports.reduceOrder)) {
    throw new Error("REDUCER_BUNDLE_PATH must export reduceOrder");
  }
  const loadedReducer = module.exports.reduceOrder;
  const reduceOrder: OrderReducer = (state, event) => {
    try {
      return loadedReducer(state, event);
    } catch {
      throw new Error("Attested reducer execution failed");
    }
  };
  return { reduceOrder, sha256 };
}
