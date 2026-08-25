import { z } from "zod";
import { canonicalSha256 } from "./canonical-json.js";
import { fingerprintCandidateProjection, fingerprintCurrentProjectionRow } from "./fingerprints.js";
import {
  isVerifiedReducerArtifactEvidence,
  type VerifiedReducerArtifactEvidence,
} from "./reducer-artifact.js";
import {
  CanonicalProjectionValueSchema,
  CurrentProjectionRowSchema,
  PositiveDecimalBigintSchema,
  RuntimeEvidenceSchema,
  Sha256Schema,
} from "./schemas.js";

const PositiveIntegerSchema = z.number().int().positive().safe();
const InvariantIdSchema = z.enum([
  "stream_versions_contiguous",
  "reducer_deterministic",
  "candidate_matches_stream_head",
  "root_projector_fix_active",
]);
type RepairInvariantId = z.infer<typeof InvariantIdSchema>;
const RequiredInvariantIds: ReadonlySet<RepairInvariantId> = new Set(InvariantIdSchema.options);

export const RepairInvariantSchema = z
  .object({
    id: InvariantIdSchema,
    passed: z.boolean(),
  })
  .strict();

const StreamEnvelopeEvidenceSchema = z
  .object({
    streamId: z.string().trim().min(1).max(128),
    headVersion: z.number().int().nonnegative().safe(),
    eventCount: z.number().int().nonnegative().safe(),
    sha256: Sha256Schema,
  })
  .strict();

const CurrentRowEnvelopeEvidenceSchema = z
  .object({
    rowVersion: PositiveDecimalBigintSchema,
    sha256: Sha256Schema,
    value: CanonicalProjectionValueSchema,
  })
  .strict();

const CandidateRowEnvelopeEvidenceSchema = z
  .object({
    sha256: Sha256Schema,
    value: CanonicalProjectionValueSchema,
  })
  .strict();

const UnsignedRepairEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: z.uuid(),
    projectionName: z.string().trim().min(1).max(128),
    stream: StreamEnvelopeEvidenceSchema,
    runtime: RuntimeEvidenceSchema,
    currentRow: CurrentRowEnvelopeEvidenceSchema,
    candidateRow: CandidateRowEnvelopeEvidenceSchema,
    invariants: z.array(RepairInvariantSchema).length(RequiredInvariantIds.size),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((envelope, context) => {
    const seen = new Set<RepairInvariantId>(envelope.invariants.map((invariant) => invariant.id));
    if (seen.size !== RequiredInvariantIds.size) {
      context.addIssue({ code: "custom", message: "Repair invariants must be unique" });
    }
    for (const required of RequiredInvariantIds) {
      if (!seen.has(required)) {
        context.addIssue({ code: "custom", message: `Missing repair invariant: ${required}` });
      }
    }
    if (envelope.invariants.some((invariant) => !invariant.passed)) {
      context.addIssue({ code: "custom", message: "Every repair invariant must pass" });
    }
    if (Date.parse(envelope.expiresAt) <= Date.parse(envelope.createdAt)) {
      context.addIssue({ code: "custom", message: "Repair evidence must expire after creation" });
    }
    if (envelope.projectionName !== envelope.runtime.projectionName) {
      context.addIssue({ code: "custom", message: "Runtime projection name does not match plan" });
    }
    if (
      envelope.stream.streamId !== envelope.currentRow.value.orderId ||
      envelope.stream.streamId !== envelope.candidateRow.value.orderId
    ) {
      context.addIssue({ code: "custom", message: "Stream and projection row IDs do not match" });
    }
    if (
      envelope.stream.headVersion !== envelope.stream.eventCount ||
      envelope.candidateRow.value.lastStreamVersion !== envelope.stream.headVersion
    ) {
      context.addIssue({ code: "custom", message: "Candidate does not match the stream head" });
    }
    if (envelope.currentRow.value.lastStreamVersion > envelope.stream.headVersion) {
      context.addIssue({ code: "custom", message: "Current row is ahead of the stream head" });
    }
    if (
      envelope.runtime.algorithmVersion !== "gap-aware-v1" ||
      envelope.runtime.gapStrategy !== "TRACKED_NON_BLOCKING"
    ) {
      context.addIssue({ code: "custom", message: "Root projector fix is not active" });
    }
  });

export const RepairEnvelopeSchema = UnsignedRepairEnvelopeSchema.extend({
  evidenceSha256: Sha256Schema,
}).strict();

export type RepairInvariant = z.infer<typeof RepairInvariantSchema>;
export type RepairEnvelope = z.infer<typeof RepairEnvelopeSchema>;

export interface BuildRepairEnvelopeInput {
  planId: string;
  projectionName: string;
  runtime: unknown;
  currentRow: unknown;
  reducerEvidence: VerifiedReducerArtifactEvidence;
  clock: () => Date;
  ttlSeconds?: number;
}

function unsignedEnvelope(envelope: RepairEnvelope): z.infer<typeof UnsignedRepairEnvelopeSchema> {
  const { evidenceSha256: _evidenceSha256, ...unsigned } = envelope;
  return unsigned;
}

function assertNestedFingerprints(
  currentRow: z.infer<typeof CurrentRowEnvelopeEvidenceSchema>,
  candidateRow: z.infer<typeof CandidateRowEnvelopeEvidenceSchema>,
): void {
  const recomputedCurrent = fingerprintCurrentProjectionRow({
    ...currentRow.value,
    rowVersion: currentRow.rowVersion,
  });
  if (recomputedCurrent.sha256 !== currentRow.sha256) {
    throw new Error("Current projection row fingerprint does not match its value");
  }
  const recomputedCandidate = fingerprintCandidateProjection(candidateRow.value);
  if (recomputedCandidate.sha256 !== candidateRow.sha256) {
    throw new Error("Candidate projection fingerprint does not match its value");
  }
}

export function buildRepairEnvelope(input: BuildRepairEnvelopeInput): RepairEnvelope {
  const ttlSeconds = PositiveIntegerSchema.parse(input.ttlSeconds ?? 300);
  const created = input.clock();
  if (!Number.isFinite(created.getTime())) {
    throw new Error("Evidence clock returned an invalid date");
  }
  const expires = new Date(created.getTime() + ttlSeconds * 1_000);
  if (!isVerifiedReducerArtifactEvidence(input.reducerEvidence)) {
    throw new Error("Repair envelope requires verified reducer artifact evidence");
  }
  const runtime = RuntimeEvidenceSchema.parse(input.runtime);
  if (runtime.reducerSha256 !== input.reducerEvidence.reducerSha256) {
    throw new Error("Executed reducer digest does not match runtime attestation");
  }
  const currentRow = fingerprintCurrentProjectionRow(input.currentRow);
  const currentValue = CurrentProjectionRowSchema.parse(currentRow.value);
  const { rowVersion, ...projectionValue } = currentValue;
  const candidateRow = fingerprintCandidateProjection(input.reducerEvidence.candidate.value);
  const candidateValue = CanonicalProjectionValueSchema.parse(candidateRow.value);
  const stream = input.reducerEvidence.stream;

  const unsigned = UnsignedRepairEnvelopeSchema.parse({
    schemaVersion: 1,
    planId: input.planId,
    projectionName: input.projectionName,
    stream: {
      streamId: stream.streamId,
      headVersion: stream.headVersion,
      eventCount: stream.eventCount,
      sha256: stream.sha256,
    },
    runtime,
    currentRow: {
      rowVersion,
      sha256: currentRow.sha256,
      value: projectionValue,
    },
    candidateRow: {
      sha256: candidateRow.sha256,
      value: candidateValue,
    },
    invariants: [
      { id: "stream_versions_contiguous", passed: true },
      {
        id: "reducer_deterministic",
        passed: input.reducerEvidence.reducerDeterministic,
      },
      {
        id: "candidate_matches_stream_head",
        passed: candidateValue.lastStreamVersion === stream.headVersion,
      },
      {
        id: "root_projector_fix_active",
        passed:
          runtime.algorithmVersion === "gap-aware-v1" &&
          runtime.gapStrategy === "TRACKED_NON_BLOCKING",
      },
    ],
    createdAt: created.toISOString(),
    expiresAt: expires.toISOString(),
  });
  assertNestedFingerprints(unsigned.currentRow, unsigned.candidateRow);
  return RepairEnvelopeSchema.parse({
    ...unsigned,
    evidenceSha256: canonicalSha256(unsigned),
  });
}

export function verifyRepairEnvelope(input: unknown): RepairEnvelope {
  const envelope = RepairEnvelopeSchema.parse(input);
  assertNestedFingerprints(envelope.currentRow, envelope.candidateRow);
  if (canonicalSha256(unsignedEnvelope(envelope)) !== envelope.evidenceSha256) {
    throw new Error("Repair evidence fingerprint does not match its envelope");
  }
  return envelope;
}
