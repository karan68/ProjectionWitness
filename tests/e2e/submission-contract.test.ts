import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function text(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, new URL("../../", import.meta.url)), "utf8");
}

describe("submission contract", () => {
  it("ships every required public artifact and disclosure", async () => {
    const required = [
      "README.md",
      "LICENSE",
      "SOURCE_OF_TRUTH.md",
      "docs/SECURITY.md",
      "docs/TRUEFORGE.md",
      "docs/QODO_EVIDENCE.md",
      "docs/AI_DISCLOSURE.md",
      "docs/DEMO.md",
      "docs/SUBMISSION.md",
      "agents/projection-witness.agent.json",
      "skills/projection-repair/SKILL.md",
    ];
    await expect(Promise.all(required.map((path) => text(path)))).resolves.toSatisfy(
      (contents: string[]) => contents.every((content) => content.trim().length > 0),
    );
  });

  it("keeps native approval on only the destructive apply tool", async () => {
    const manifest = JSON.parse(await text("agents/projection-witness.agent.json")) as {
      mcpServers: Array<{
        name: string;
        enableTools: string[];
        requireApprovalForTools: string[];
      }>;
      config: { sandbox: { enabled: boolean }; dynamicSubAgents: { enabled: boolean } };
    };
    expect(manifest.mcpServers).toEqual([
      expect.objectContaining({
        name: "projection-witness-read",
        enableTools: ["@all"],
        requireApprovalForTools: [],
      }),
      expect.objectContaining({
        name: "projection-witness-write",
        enableTools: ["apply_projection_repair"],
        requireApprovalForTools: ["apply_projection_repair"],
      }),
    ]);
    expect(manifest.config).toMatchObject({
      sandbox: { enabled: true },
      dynamicSubAgents: { enabled: true },
    });
  });

  it("fails test discovery closed and exposes the release evidence commands", async () => {
    const packageJson = JSON.parse(await text("package.json")) as {
      scripts: Record<string, string>;
    };
    const vitestConfig = await text("vitest.workspace.ts");
    expect(vitestConfig).not.toContain("passWithNoTests");
    for (const scriptName of [
      "ci",
      "test:e2e",
      "test:integration",
      "test:race",
      "test:unit",
      "evidence:trueforge-daytona",
      "trueforge:verify-approved-repair",
    ]) {
      expect(packageJson.scripts[scriptName]).toBeTruthy();
      expect(packageJson.scripts[scriptName]).not.toContain("passWithNoTests");
    }
  });

  it("states the narrow product and residual security boundary", async () => {
    const readme = await text("README.md");
    const security = await text("docs/SECURITY.md");
    const disclosure = await text("docs/AI_DISCLOSURE.md");
    expect(readme).toContain("exactly one");
    expect(security).toContain("not a general database agent");
    expect(security).toContain("Standalone TrueForge local mode has no login boundary");
    expect(disclosure).toContain("The language model never supplies the repair candidate");
  });
});
