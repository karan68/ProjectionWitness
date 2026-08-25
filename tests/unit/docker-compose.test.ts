import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("demo database reset guard", () => {
  it("refuses demo reset without explicit demo mode before invoking Docker", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/docker-compose.ts", "demo-reset"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CONFIRM_DATABASE_RESET: "projection-witness-local",
          DEMO_MODE: "false",
          NODE_ENV: "test",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEMO_MODE=true is required for demo database reset");
    expect(result.stdout).not.toContain("down");
  });
});
