import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 10_000,
    include: ["tests/**/*.test.ts", "apps/**/*.test.ts", "packages/**/*.test.ts"],
    passWithNoTests: true,
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
