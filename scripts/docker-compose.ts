import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type DatabaseAction = "config" | "demo-reset" | "down" | "reset" | "serve" | "up";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const composeFile = resolve(projectRoot, "docker-compose.yml");

function parseAction(value: string | undefined): DatabaseAction {
  if (
    value === "config" ||
    value === "demo-reset" ||
    value === "down" ||
    value === "reset" ||
    value === "serve" ||
    value === "up"
  ) {
    return value;
  }

  throw new Error("Usage: tsx scripts/docker-compose.ts <config|demo-reset|down|reset|serve|up>");
}

function toWslPath(windowsPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  const drive = match?.[1];
  const remainder = match?.[2];

  if (drive === undefined || remainder === undefined) {
    throw new Error(`Cannot translate path for WSL: ${windowsPath}`);
  }

  return `/mnt/${drive.toLowerCase()}/${remainder.replaceAll("\\", "/")}`;
}

function getEnvironmentVariable(name: string): string | undefined {
  return process.env[name];
}

function getWslEnvironmentArguments(): string[] {
  const postgresPort = getEnvironmentVariable("POSTGRES_PORT");
  if (postgresPort === undefined) {
    return [];
  }

  const parsedPort = Number(postgresPort);
  if (!/^\d+$/.test(postgresPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw new Error("POSTGRES_PORT must be an integer from 1 through 65535");
  }

  return [`POSTGRES_PORT=${postgresPort}`];
}

async function runCompose(arguments_: readonly string[]): Promise<void> {
  const isWindows = process.platform === "win32";
  const command = isWindows ? "wsl.exe" : "docker";
  const argumentsPrefix = isWindows
    ? [
        "-d",
        getEnvironmentVariable("PW_WSL_DISTRO") ?? "Ubuntu",
        "--",
        "env",
        ...getWslEnvironmentArguments(),
        "docker",
        "compose",
        "--file",
        toWslPath(composeFile),
      ]
    : ["compose", "--file", composeFile];

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...argumentsPrefix, ...arguments_], {
      stdio: "inherit",
    });

    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      const outcome = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
      rejectPromise(new Error(`Docker Compose failed with ${outcome}`));
    });
  });
}

async function main(): Promise<void> {
  const action = parseAction(process.argv[2]);

  if (action === "config") {
    await runCompose(["config", "--quiet"]);
    return;
  }

  if (action === "up") {
    await runCompose(["up", "--detach", "--wait", "postgres"]);
    return;
  }

  if (action === "serve") {
    await runCompose(["up", "postgres"]);
    return;
  }

  if (action === "down") {
    await runCompose(["down"]);
    return;
  }

  if (getEnvironmentVariable("NODE_ENV") === "production") {
    throw new Error("Database reset is disabled when NODE_ENV=production");
  }

  if (action === "demo-reset" && getEnvironmentVariable("DEMO_MODE") !== "true") {
    throw new Error("DEMO_MODE=true is required for demo database reset");
  }

  if (getEnvironmentVariable("CONFIRM_DATABASE_RESET") !== "projection-witness-local") {
    throw new Error(
      "Set CONFIRM_DATABASE_RESET=projection-witness-local to reset the local database",
    );
  }

  await runCompose(["down", "--volumes", "--remove-orphans"]);
  await runCompose(["up", "--detach", "--wait", "postgres"]);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown database command failure";
  console.error(message);
  process.exitCode = 1;
});
