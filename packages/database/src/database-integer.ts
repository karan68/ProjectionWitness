const DecimalIntegerPattern = /^(?:0|[1-9]\d*)$/;

export function parseSafeDatabaseInteger(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string" || !DecimalIntegerPattern.test(value)) {
    throw new Error(`${fieldName} is not a decimal integer`);
  }

  const parsed = BigInt(value);
  if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${fieldName} exceeds the safe integer range`);
  }
  return Number(parsed);
}
