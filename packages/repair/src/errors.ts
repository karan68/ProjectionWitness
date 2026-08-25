export type RepairErrorCode =
  | "ALREADY_APPLIED"
  | "APPLY_FAILED"
  | "LOCK_TIMEOUT"
  | "NOOP_ALREADY_CORRECT"
  | "PLAN_EXPIRED"
  | "PLAN_INVALID"
  | "ROOT_CAUSE_UNSAFE"
  | "RUNTIME_UNATTESTED"
  | "STALE_PLAN"
  | "VERIFICATION_FAILED";

export class RepairError extends Error {
  readonly code: RepairErrorCode;
  readonly mismatchCategories: readonly string[];

  constructor(code: RepairErrorCode, message: string, mismatchCategories: readonly string[] = []) {
    super(message);
    this.name = "RepairError";
    this.code = code;
    this.mismatchCategories = mismatchCategories;
  }
}
