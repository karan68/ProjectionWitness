# Gap-Aware Projector And Runtime Attestation

Last verified: 2026-08-26

## Scope

Gap-aware projector v2 prevents a newly observed cross-stream commit gap from becoming a silent,
permanent projection error. It does not reconstruct a gap that naive projector v1 skipped before
v2 inherited the checkpoint.

For each poll, v2:

1. Locks its checkpoint in a bounded transaction.
2. Rechecks recorded positions whose events are now visible and whose preceding stream version is
   represented by the projection row.
3. Reads a bounded batch of committed events above the checkpoint.
4. Records every absent numeric position before advancing past a visible higher position.
5. Applies available events in numeric global-position order while requiring contiguous per-stream
   versions.
6. Keeps a visible event in `projection_gaps` when its preceding stream version is not represented.
7. Removes a tracked position only after its event is applied or is already represented.
8. Advances the checkpoint and projection/gap state in the same transaction.

A blocked historical stream does not occupy the bounded visible-gap batch: the query selects only
positions that are currently applicable or already represented, so unrelated resolvable work can
continue.

## Permanent Sequence Holes

PostgreSQL sequence allocation is non-transactional, so a rolled-back append leaves a position
that can never become visible. V2 retires such a position only when both configured conditions are
true:

- It has remained absent for at least `gapRetentionMs` (default: 300000 ms).
- It is at least `gapRetentionDistance` behind the checkpoint (default: 10000 positions).

The delete rechecks that no event is visible at that position. A single poll refuses to track more
than `maxObservedGapSpan` positions (default: 10000) instead of allocating unbounded memory or SQL
parameters.

This is an explicit liveness policy, not proof that an old missing position was rolled back. An
unusually long transaction that commits after both thresholds can arrive after retirement. The
reference values are demo defaults and must be set above the deployment's maximum permitted
transaction lifetime and expected sequence distance before production use.

## Runtime Manifest

Migration `0003_projection_runtime.sql` adds one manifest per projection:

- Positive, monotonically increasing generation.
- SHA-256 of the reducer module bytes loaded by the projector process.
- Built source commit.
- Algorithm version `gap-aware-v1`.
- Gap strategy `TRACKED_NON_BLOCKING`.

Registration takes a transaction-scoped advisory lock before locking or creating the manifest row.
An identical registration is idempotent. Changed metadata at the same or a lower generation is
refused, and the upsert independently requires an increasing generation.

`assertRepairSafeProjectionRuntime` returns `RUNTIME_UNATTESTED` for a missing manifest and
`ROOT_CAUSE_UNSAFE` unless both the known algorithm and gap strategy are active. Later repair-plan
code must call this check before staging evidence.

## Starting V2

Build the self-contained reducer artifact first so `REDUCER_BUNDLE_PATH` identifies the exact
executable bytes:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run build:reducer

$env:DATABASE_URL_PROJECTOR = "postgresql://pw_projector:<local-password>@127.0.0.1:55432/projection_witness"
$env:PROJECTOR_MODE = "gap-aware-v1"
$env:PROJECTOR_GENERATION = "2"
$env:SOURCE_COMMIT_SHA = "<exact-built-commit>"
$env:REDUCER_BUNDLE_PATH = ".\artifacts\order-reducer.<sha256-from-build>.cjs"

& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run dev:projector:v2
```

The process allows only the known artifact path and rejects symbolic links. It opens the regular
content-addressed file, checks the filename digest, reads and hashes it once, then evaluates those
already-read bytes in a restricted VM context
under a fixed non-secret filename. A concurrent build or path replacement therefore cannot make
the manifest attest different bytes than the reducer being executed, and failures cannot expose an
encoded source URL. Builds publish immutable digest-named files through a same-directory temporary
file, `fsync`, and atomic rename; concurrent builders either create or verify the same complete
artifact without replacing a live file.
The projector registers that digest through `pw_projector`, then begins polling. Runtime
attestation remains evidence that future repair code must independently lock and recheck.

## Verified Evidence

The PostgreSQL integration suite proves:

- Position $N$ can remain uncommitted while unrelated $N+1$ is processed and checkpointed.
- V2 records $N$, continues the unrelated stream, and applies $N$ after it commits.
- V2 deployed after v1's skip does not invent the old position.
- A later event from that historically broken stream remains blocked and tracked.
- An old, distant, permanently absent sequence position is retired by the explicit policy.
- Runtime registration works through the least-privilege `pw_projector` login, is idempotent, and
  refuses changed metadata without a generation increase.

The startup smoke loaded the emitted reducer module, registered generation 2 through
`pw_projector`, and reported its SHA-256 before polling.