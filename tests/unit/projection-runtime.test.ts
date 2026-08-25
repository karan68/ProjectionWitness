import {
  assertRepairSafeProjectionRuntime,
  GapAwareAlgorithmVersion,
  ProjectionRuntimeSafetyError,
  TrackedNonBlockingGapStrategy,
  type ProjectionRuntime,
} from "@projection-witness/database";
import { describe, expect, it } from "vitest";

const safeRuntime: ProjectionRuntime = {
  projectionName: "orders",
  generation: "2",
  reducerSha256: "a".repeat(64),
  sourceCommitSha: "0123456789abcdef",
  algorithmVersion: GapAwareAlgorithmVersion,
  gapStrategy: TrackedNonBlockingGapStrategy,
  registeredAt: new Date("2026-08-26T00:00:00.000Z"),
};

describe("projection runtime safety", () => {
  it("accepts only the known gap-aware runtime", () => {
    expect(() => assertRepairSafeProjectionRuntime(safeRuntime)).not.toThrow();
  });

  it("refuses a missing runtime as unattested", () => {
    expect.assertions(2);
    try {
      assertRepairSafeProjectionRuntime(undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectionRuntimeSafetyError);
      expect((error as ProjectionRuntimeSafetyError).code).toBe("RUNTIME_UNATTESTED");
    }
  });

  it.each([
    { algorithmVersion: "naive-v1", gapStrategy: TrackedNonBlockingGapStrategy },
    { algorithmVersion: GapAwareAlgorithmVersion, gapStrategy: "UNKNOWN" },
  ])("refuses an unsafe active runtime", (override) => {
    expect.assertions(2);
    try {
      assertRepairSafeProjectionRuntime({ ...safeRuntime, ...override });
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectionRuntimeSafetyError);
      expect((error as ProjectionRuntimeSafetyError).code).toBe("ROOT_CAUSE_UNSAFE");
    }
  });
});
