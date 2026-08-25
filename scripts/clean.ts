import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

async function removeWorkspaceOutputs(parent: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries.map((entry) => rm(join(parent, entry, "dist"), { recursive: true, force: true })),
  );
}

await Promise.all([
  removeWorkspaceOutputs("apps"),
  removeWorkspaceOutputs("packages"),
  rm("tsconfig.tsbuildinfo", { force: true }),
]);
