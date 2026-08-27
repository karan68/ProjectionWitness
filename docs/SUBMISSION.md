# Submission Runbook

Last verified: 2026-08-27

## Product Summary

Projection Witness is a TrueForge agent for proof-carrying, stale-safe repair of one corrupted
event-sourced PostgreSQL order projection row. It reconciles customer API, immutable stream,
projection row, and deployed reducer evidence; runs the exact reducer; stages an immutable plan;
requires native approval for the sole destructive tool; and atomically refuses if the approved
evidence changed.

The originality is not replay. It is approval bound to stream, deployed reducer, current row, exact
candidate, and expiry, with one-row CAS and append-only audit in the same transaction.

## TrueForge Usage

TrueForge is runtime-critical rather than a model wrapper:

- Two owned Streamable HTTP MCP connectors expose seven bounded read/stage/verify tools and one
  destructive apply tool.
- The saved agent has Daytona sandbox access, dynamic subagents, persisted sessions, and an
  apply-only native approval policy.
- Persisted events prove real MCP initialization, Daytona creation, native denial, native allow,
  exact write arguments, write receipt, and independent post-write reads.
- Sequence-based reconnect stores the real server SSE cursor and resumes the same turn.

Exact versions, agent IDs, session IDs, hashes, and limitations are in `TRUEFORGE.md`,
`EVIDENCE.md`, and `DEMO.md`.

## Three-Minute Recording

Target runtime: 2:45.

1. **0:00-0:20, symptom:** show `ORD-1042` as `AWAITING_PAYMENT`, then show the immutable payment
   event and explain that no job failed.
2. **0:20-0:50, investigation:** ask Projection Witness to investigate; show API, stream/row, and
   runtime evidence converging in TrueForge.
3. **0:50-1:15, deterministic proof:** show `sandbox.created`, exact reducer SHA-256, stream hash,
   old row hash, candidate hash, and expiry.
4. **1:15-1:35, reconnect:** stop only the client, reconnect with the saved session/turn/sequence,
   and show the same pending action without duplicate work.
5. **1:35-1:58, stale refusal:** use a prepared stale-plan recording or live case; allow the old
   binding and show `STALE_PLAN` with unchanged row/audit.
6. **1:58-2:30, repair:** show the fresh native approval card, click `Allow`, and show the one-row
   receipt.
7. **2:30-2:45, verify:** show plan `APPLIED`, audit hash match, row version increment, public API
   `PAID`, green CI, and visible Qodo review history.

Do not expose credentials, local environment files, raw provider settings, or unrelated terminal
history. Keep a local backup of the final video and verify its public link in a signed-out browser.

## Executable Release Gate

From a clean clone of the candidate commit:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" ci
$env:DATABASE_URL_MIGRATOR = "postgresql://..."
$env:DATABASE_URL_API = "postgresql://..."
$env:DATABASE_URL_PROJECTOR = "postgresql://..."
$env:DATABASE_URL_MCP_READ = "postgresql://..."
$env:DATABASE_URL_MCP_WRITE = "postgresql://..."
$env:DATABASE_URL_REPAIR_EXECUTOR = "postgresql://..."
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run db:migrate
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run db:bootstrap-roles
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run ci
+```

Required result: no skipped test directories, all ten repair reliability cases pass, production
audit has zero high-severity vulnerabilities, reducer digest is unchanged, and required GitHub CI
is green at the tagged commit.

External gates are rerun separately because they require provider credentials:

- `npm run evidence:trueforge-daytona -- <commit> <reducer-sha256>` must end in the strict
   persisted-evidence verifier, not merely `sandbox.created`.
- A saved-agent case must persist three non-root subagent threads.
- A client must disconnect while a turn is running and reconnect to the same session/turn using
   the saved server SSE sequence.

## Claims Checklist

- Claim one order projection row, not generic database repair.
- Claim reducer-derived candidate, not inferred business truth.
- Claim local standalone correlation IDs, not authenticated approver identity.
- Distinguish deterministic worker execution from real Daytona execution.
- State external provider failures plainly and never substitute local shell output.
- Do not claim whole-projection rebuild, arbitrary frameworks, or automatic repair.

## Operator-Owned Final Steps

These cannot be completed safely by an automated coding agent:

- Record and upload the approximately three-minute demo.
- Confirm every team member's event registration and final team name.
- Fill the official submission form fields and submit before the deadline.
- Capture the confirmation page/email and archive the final public video URL.

Before those steps, run a secret scan over Git history and inspect screenshots/video manually.
