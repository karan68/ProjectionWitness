# Event Store

Last verified: 2026-08-25

## Scope

The current implementation owns one narrow order event-store contract:

- Strict `OrderPlaced`, `PaymentCaptured`, and `OrderShipped` schemas.
- Non-negative safe-integer cents.
- A pure reducer that requires stream identity and contiguous stream versions.
- One PostgreSQL event store with expected-version appends.
- Immutable event rows enforced by privileges and a defensive trigger.

The event store remains a narrow package boundary. The repository now also contains the reviewed
Order API, projection tables, both projector algorithms, genuine out-of-order reproducer,
evidence fingerprints, repair plan/transaction, and MCP connectors; those layers consume this
contract without adding general SQL or event-mutation APIs here.

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
passwords separately from the five secret runtime URLs with `npm run db:bootstrap-roles`. The
migration-owner connection is never a runtime API connection. Integration tests authenticate
directly as all five runtime identities; event-store behavior runs through `pw_api`, not an
impersonated migrator session.

## Verification

The unit suite covers reducer transitions, schema rejection, version gaps, cross-stream events,
safe-integer accumulation, explicit overpayment-as-paid behavior, and non-mutation of prior state.

The real PostgreSQL suite covers:

- Exact expected-version append and ordered stream reads.
- Exactly one winner for two concurrent version-zero appends.
- No stream head or event after a missing stream is expected at a nonzero version.
- No inserted event after stale or invalid attempts.
- Bounded lock and statement waits under a deliberately held stream-head lock.
- Connection reuse after a lock timeout rollback.
- Event mutation refusal through both role permissions and the owner-visible trigger.
- Read-only event access for projector and MCP evidence roles without insert permission.
- Idempotent migration and stored checksum.
- Refusal when an applied migration filename is presented with different contents.
- Permanent global-position sequence holes after a post-`nextval` rollback.

The repeated concurrency suite and the genuine projector checkpoint race are intentionally not
claimed here; they belong to PR 3.