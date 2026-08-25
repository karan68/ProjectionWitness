export { ExpectedVersionConflictError, InvalidOrderStreamError } from "./errors.js";
export { parseSafeDatabaseInteger } from "./database-integer.js";
export {
  OrderEventStore,
  type AppendOrderEventInput,
  type OrderEventStoreOptions,
  type StoredOrderEvent,
} from "./event-store.js";
export { migrateDatabase, type MigrationResult } from "./migrations.js";
export { createDatabasePool, type DatabasePoolOptions } from "./pool.js";
export {
  assertRepairSafeProjectionRuntime,
  GapAwareAlgorithmVersion,
  getProjectionRuntime,
  ProjectionRuntimeSafetyError,
  registerProjectionRuntime,
  TrackedNonBlockingGapStrategy,
  type ProjectionRuntime,
  type ProjectionRuntimeManifest,
  type ProjectionRuntimeSafetyCode,
} from "./projection-runtime.js";
export {
  provisionRuntimeRoles,
  type ProvisionRuntimeRolesInput,
  type RuntimeRole,
  type RuntimeRoleUrls,
} from "./runtime-roles.js";
