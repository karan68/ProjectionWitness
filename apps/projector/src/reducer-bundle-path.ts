import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { normalize, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import {
  OrderProjectionSchema,
  type OrderEvent,
  type OrderProjection,
} from "@projection-witness/domain";
import type { OrderReducer } from "./gap-aware-projector.js";

export const ApprovedOrderReducerSha256 =
  "4decce13b48e3aeff9402b36c13bf2a995b176f2c7e11e203c83d03b8b23e637";
const MaximumReducerBundleBytes = 1_048_576;
const ReducerExecutionTimeoutMs = 2_000;
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

type ReducerWorkerRequest =
  | { type: "probe" }
  | { type: "reduce"; state: OrderProjection | null; event: OrderEvent };

const ReducerWorkerResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("result"), first: z.unknown(), second: z.unknown() }).strict(),
  z.object({ type: z.literal("error") }).strict(),
]);

const ReducerWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { createContext, Script } = require("node:vm");

function loadReducer(replayPass) {
  const reducerModule = { exports: {} };
  const context = createContext({
    __projectionWitnessReplayPass: replayPass,
    module: reducerModule,
    exports: reducerModule.exports,
  });
  new Script(workerData.source, {
    filename: "projection-witness-order-reducer.cjs",
  }).runInContext(context);
  if (typeof reducerModule.exports.reduceOrder !== "function") {
    throw new Error("missing reducer");
  }
  return reducerModule.exports.reduceOrder;
}

async function main() {
  if (workerData.request.type === "probe") {
    loadReducer(0);
    parentPort.postMessage({ type: "ready" });
  } else {
    const run = async (replayPass) => {
      const reduceOrder = loadReducer(replayPass);
      return await reduceOrder(
        structuredClone(workerData.request.state),
        structuredClone(workerData.request.event),
      );
    };
    parentPort.postMessage({ type: "result", first: await run(1), second: await run(2) });
  }
}

main().catch(() => parentPort.postMessage({ type: "error" }));
`;

export async function executeReducerSource(
  source: string,
  request: ReducerWorkerRequest,
  timeoutMs = ReducerExecutionTimeoutMs,
): Promise<{ first: unknown; second: unknown } | undefined> {
  const boundedTimeout = z.number().int().positive().max(60_000).parse(timeoutMs);
  const worker = new Worker(ReducerWorkerSource, {
    env: {},
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    workerData: { request, source },
  });

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      action();
    };
    const timer = setTimeout(
      () => finish(() => rejectPromise(new Error("Attested reducer execution timed out"))),
      boundedTimeout,
    );
    worker.once("message", (message: unknown) => {
      const parsed = ReducerWorkerResponseSchema.safeParse(message);
      if (!parsed.success) {
        finish(() => rejectPromise(new Error("Attested reducer execution failed")));
        return;
      }
      const response = parsed.data;
      if (response.type === "error") {
        finish(() => rejectPromise(new Error("Attested reducer execution failed")));
        return;
      }
      if (response.type === "ready") {
        finish(() => resolvePromise(undefined));
        return;
      }
      finish(() => resolvePromise({ first: response.first, second: response.second }));
    });
    worker.once("error", () =>
      finish(() => rejectPromise(new Error("Attested reducer execution failed"))),
    );
    worker.once("exit", (code) => {
      finish(() =>
        rejectPromise(
          new Error(
            code === 0
              ? "Attested reducer worker returned no result"
              : "Attested reducer execution failed",
          ),
        ),
      );
    });
  });
}

export function validateDeterministicReducerResults(result: {
  first: unknown;
  second: unknown;
}): OrderProjection {
  const first = OrderProjectionSchema.parse(result.first);
  const second = OrderProjectionSchema.parse(result.second);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("Attested reducer output is not deterministic");
  }
  return first;
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
    if (fileInfo.size > MaximumReducerBundleBytes) {
      throw new Error("REDUCER_BUNDLE_PATH exceeds the 1048576 byte limit");
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
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("REDUCER_BUNDLE_PATH is not valid UTF-8 JavaScript");
  }
  if (sha256 !== ApprovedOrderReducerSha256) {
    throw new Error("REDUCER_BUNDLE_PATH digest is not approved by this projector build");
  }
  await executeReducerSource(source, { type: "probe" });
  const reduceOrder: OrderReducer = async (state, event) => {
    const result = await executeReducerSource(source, { type: "reduce", state, event });
    if (result === undefined) {
      throw new Error("Attested reducer execution returned no result");
    }
    return validateDeterministicReducerResults(result);
  };
  return { reduceOrder, sha256 };
}
