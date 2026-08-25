export class ExpectedVersionConflictError extends Error {
  readonly code = "EXPECTED_VERSION_CONFLICT";
  readonly streamId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(streamId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Expected stream ${streamId} at version ${String(expectedVersion)}, but it is at ${String(actualVersion)}`,
    );
    this.name = "ExpectedVersionConflictError";
    this.streamId = streamId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class InvalidOrderStreamError extends Error {
  readonly code = "INVALID_ORDER_STREAM";

  constructor(message: string) {
    super(message);
    this.name = "InvalidOrderStreamError";
  }
}
