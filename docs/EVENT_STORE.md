# Event Store

Last verified: 2026-08-25

## Scope

The current implementation owns one narrow order event-store contract:

- Strict `OrderPlaced`, `PaymentCaptured`, and `OrderShipped` schemas.
- Non-negative safe-integer cents.
- A pure reducer that requires stream identity and contiguous stream versions.
- One PostgreSQL event store with expected-version appends.
- Immutable event rows enforced by privileges and a defensive trigger.

It does not yet include the Order API, projection tables, projector, out-of-order commit
reproducer, evidence fingerprints, repair plan, MCP server, or repair transaction. Those remain
separate reviewed pull requests.

## Append Transaction

`OrderEventStore.append` uses one checked-out `pg` client for the entire transaction:

1. Begin and set local lock and statement timeouts.
2. Insert the stream head at version zero when absent, using `ON CONFLICT DO NOTHING`.
3. Lock the stream head with `FOR UPDATE`.
4. Compare the locked version with the caller's exact expected version.
5. Reject an invalid first event or repeated `OrderPlaced`.
6. Insert one typed event with an application-generated UUID.
7. Compare-and-swap the stream head to the new version.
8. Commit, or roll back on every error, and release the client in `finally`.

Different streams are not serialized against one another. PostgreSQL sequence allocation may
therefore occur in an order different from commit order, which is required for the genuine gap
reproduction in the next projector PR.

## Migration Contract

Migration `0001_event_store.sql` creates:

- `event_global_position_seq` with `CACHE 1`.
- `event_streams` and `events`.
- Unique global position and stream-version constraints.
- The ordered stream index.
- An `UPDATE`/`DELETE` rejection trigger on `events`.
- No-login runtime role shells and the narrow `pw_api` event-store grants.

`npm run db:migrate` serializes migration runners with a transaction-scoped advisory lock. It
records the SHA-256 of every applied filename in `schema_migrations`; a changed applied file is a
hard error rather than an implicit rewrite.

Runtime login credentials are not created by migration SQL. The local/demo bootstrap must grant
login separately from committed secrets. The migration-owner connection is never a runtime API
connection.

## Verification

The unit suite covers reducer transitions, schema rejection, version gaps, cross-stream events,
safe-integer accumulation, and non-mutation of prior state.

The real PostgreSQL suite covers:

- Exact expected-version append and ordered stream reads.
- Exactly one winner for two concurrent version-zero appends.
- No inserted event after stale or invalid attempts.
- Event mutation refusal through both role permissions and the owner-visible trigger.
- Idempotent migration and stored checksum.
- Refusal when an applied migration filename is presented with different contents.

The repeated concurrency suite and the genuine projector checkpoint race are intentionally not
claimed here; they belong to PR 3.