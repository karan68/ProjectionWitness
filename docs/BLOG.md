# Projection Witness: Approval For One Proven Repair

An event-sourced system can preserve every fact and still show the wrong answer.

That is the failure Projection Witness handles. A globally tracked projector observes a later
commit while an earlier event is temporarily invisible, advances its checkpoint, and never revisits
the skipped position. The immutable event stream says an order is paid. The customer-facing
PostgreSQL read model says it is awaiting payment. Nothing crashed, so an ordinary retry queue has
nothing to retry.

Projection Witness is a TrueForge agent that investigates and, only when the evidence permits,
repairs exactly one corrupted order projection row. Its central promise is narrow: approval
authorizes one fingerprinted repair attempt. If the stream, deployed reducer, current row, candidate,
or expiry changes while a person decides, the transaction refuses with zero writes.

## The Agent's Job

The agent starts from a symptom, not a target value. It reconciles four evidence planes:

- The public order API.
- The immutable event stream and projection row.
- The deployed projector runtime and reducer digest.
- A deterministic replay of the bounded stream with the exact attested reducer.

The language model never invents the repaired row. A content-addressed reducer bundle computes it
twice in isolation. Projection Witness then stages an immutable plan binding the stream head and
hash, reducer generation and digest, current row version and hash, candidate hash, plan ID, and
expiry.

The only destructive MCP tool is `apply_projection_repair`. TrueForge pauses that literal call for
native human approval. PostgreSQL then acquires locks in the fixed global order: repair plan,
runtime manifest, stream head, and projection row. It recomputes the evidence, performs a one-row
compare-and-swap, and appends an audit receipt in the same transaction. A mismatch returns
`STALE_PLAN`; an audit failure rolls back the row update.

## Why TrueForge Is Central

TrueForge is the runtime boundary, not a wrapper around one model request.

Two owned Streamable HTTP MCP connectors expose seven bounded read, stage, and verify tools, plus
the single approval-gated apply tool. TrueForge provides the saved agent, persisted event log,
Daytona sandbox, native approval card, dynamic subagents, and resumable turn stream.

The final evidence includes:

- A real Daytona sandbox rebuilding the reducer from exact public commit `7c3732d`, matching SHA-256
  `4decce13b48e3aeff9402b36c13bf2a995b176f2c7e11e203c83d03b8b23e637`, and reproducing the fixed
  stream and candidate hashes. The repository verifier accepted the complete persisted event chain.
- Three real dynamic child threads created in parallel for public impact, stream/projection state,
  and runtime provenance. Each used a read MCP tool; none staged or applied a repair.
- A client disconnect during a running 120-second sandbox turn, followed by subscription to the
  same session and turn from saved SSE cursor 5 through cursor 11. No replacement work was created.
- Separate native deny and allow decisions. Denial left the plan, row, audit, and API unchanged.
  Allow applied one row, wrote one audit receipt, and was independently verified through both the
  database and public API.

Exact session, turn, sandbox, plan, call, and hash identifiers are recorded in
[EVIDENCE.md](EVIDENCE.md), [TRUEFORGE.md](TRUEFORGE.md), and [DEMO.md](DEMO.md).

## What Broke Along The Way

The difficult part was not replaying two events. It was making every proof claim survive hostile
timing and unreliable infrastructure.

The first Daytona image had Python but no Node, so the sandbox workflow bootstraps checksum-pinned
Node 22.23.2. The image also lacked `xz`, which forced a switch to the official gzip archive. A
production-only install omitted the locked TypeScript build tools. Network failures left partial
dependency trees. Soft timeouts could leave lifecycle processes running. A predictable temporary
path allowed a checksum-versus-execution race. Gemini's free tier eventually exhausted its daily
quota.

Each failure became a narrower contract: locked development dependencies with lifecycle scripts
disabled, one bounded retry after removing partial modules, aggregate TERM/KILL deadlines below the
provider limit, a private temporary root cleaned on every exit, and hashing plus executing the same
in-memory bytes. For the final evidence run, a local Qwen model selected the exact tool call through
TrueForge; acceptance still came from persisted events and a deterministic repository verifier,
not model prose.

## How Qodo Changed The Build

Qodo reviewed every substantive pull request. Its findings materially changed the implementation:
artifact path races became single-handle reads, forgeable text matching became strict structured
event verification, broad database privileges became a separate internal executor identity, and
synthetic reconnect counters became real server SSE cursors.

[PR #11](https://github.com/karan68/ProjectionWitness/pull/11) is a representative example. Qodo
found incomplete timeout accounting, early-failure cleanup gaps, mutable script paths, and missing
behavioral tests. The final reviewed head bounded the complete Daytona launcher, executed only
verified bytes, cleaned private roots on setup failure, and added executable TERM-resistant timeout
tests. Qodo's follow-up reported zero bugs and zero rule violations.

## What I Learned

The strongest safety mechanism is not a confident agent. It is a transaction that can prove the
approved facts are still true.

This project also changed how I think about harnesses. Subagents, sandboxes, approvals, and
reconnects are not demo decorations when they own real boundaries: parallel evidence gathering,
untrusted code execution, human authorization, and continuity of one durable operation. The model
coordinates those boundaries, but it does not get to redefine them.

Projection Witness deliberately stops at one event-sourced order row. Replay is familiar; the new
piece is carrying exact proof into approval and then rechecking that proof atomically at the write.
That narrowness made the promise testable, falsifiable, and safe enough to demonstrate end to end.

Repository: [karan68/ProjectionWitness](https://github.com/karan68/ProjectionWitness)
