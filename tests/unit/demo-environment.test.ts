import { requireDemoDatabaseUrl } from "../../scripts/demo-environment.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const LoopbackDatabaseUrl = "postgresql://demo:demo@127.0.0.1:55432/projection_witness";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireDemoDatabaseUrl", () => {
  it("refuses production even when demo mode is enabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("DATABASE_URL_MIGRATOR", LoopbackDatabaseUrl);

    expect(() => requireDemoDatabaseUrl()).toThrow(/refuse NODE_ENV=production/);
  });

  it("requires explicit demo mode", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("DATABASE_URL_MIGRATOR", LoopbackDatabaseUrl);

    expect(() => requireDemoDatabaseUrl()).toThrow(/DEMO_MODE=true/);
  });

  it("requires a migration-owner database URL", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("DATABASE_URL_MIGRATOR", "");

    expect(() => requireDemoDatabaseUrl()).toThrow(/DATABASE_URL_MIGRATOR is required/);
  });

  it("refuses a non-loopback database host", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv(
      "DATABASE_URL_MIGRATOR",
      "postgresql://demo:demo@database.example.com:5432/projection_witness",
    );

    expect(() => requireDemoDatabaseUrl()).toThrow(/loopback database host/);
  });

  it("refuses node-postgres query-parameter host overrides", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv(
      "DATABASE_URL_MIGRATOR",
      `${LoopbackDatabaseUrl}?host=database.example.com&port=5432`,
    );

    expect(() => requireDemoDatabaseUrl()).toThrow(/must not contain query parameters/);
  });

  it("returns a loopback URL unchanged", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("DATABASE_URL_MIGRATOR", LoopbackDatabaseUrl);

    expect(requireDemoDatabaseUrl()).toBe(LoopbackDatabaseUrl);
  });
});
