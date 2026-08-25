import canonicalize from "canonicalize";
import { createHash } from "node:crypto";
import { z } from "zod";

const JsonValueSchema = z.json();

export type JsonValue = z.infer<typeof JsonValueSchema>;

export function canonicalJson(value: unknown): string {
  const parsed = JsonValueSchema.parse(value);
  const result = canonicalize(parsed);
  if (result === undefined) {
    throw new Error("Canonicalization returned no JSON value");
  }
  return result;
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}
