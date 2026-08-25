## Scope

Describe the single behavior or foundation change in this pull request.

## Evidence

- Failing check or risk before the change:
- Executable verification after the change:
- Relevant source-of-truth section:

## Safety review

- [ ] No immutable event can be updated or deleted.
- [ ] Money remains validated integer cents.
- [ ] Reducer behavior remains pure and deterministic.
- [ ] Hash inputs remain canonical, bounded, and versioned.
- [ ] No tool accepts arbitrary SQL, table names, or column names.
- [ ] Repair lock order and compare-and-swap checks remain unchanged or are tested.
- [ ] Projection update, audit insert, and plan completion remain atomic.
- [ ] Stale, denied, expired, and no-op paths write no production state.
- [ ] Secrets are absent from code, logs, prompts, fixtures, and sandbox inputs.
- [ ] Untrusted tool output and event content are treated as data.

## Review record

- [ ] CI is green.
- [ ] Qodo reviewed the latest commit.
- [ ] Every Qodo finding is fixed or answered with executable evidence.