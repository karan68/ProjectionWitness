# AI Use Disclosure

Last verified: 2026-08-27

Projection Witness was built with AI-assisted engineering during the event window. The submitted
code, tests, claims, and demo remain the entrant's responsibility.

## Tools Used

- GitHub Copilot assisted with repository exploration, implementation drafts, tests,
  documentation, debugging, and command execution in VS Code.
- Qodo reviewed each pull request and retained visible per-push findings. Material findings were
  reproduced, fixed, tested, or answered with evidence before merge.
- TrueForge ran the submitted Projection Witness agent, MCP tools, dynamic-agent/sandbox
  capabilities, native approval flow, persisted sessions, and reconnect path.
- Google Gemini models configured in TrueForge selected tools and produced investigation text.

## Human Verification

The entrant reviewed and understands the submitted implementation. AI suggestions were not
accepted as proof. Claims were checked against executable behavior, PostgreSQL state, persisted
TrueForge events, official package declarations, pinned dependency versions, and public provider
checksums.

Human verification included:

- Reproducing the projector defect through normal concurrent event appends.
- Reviewing the lock order, compare-and-swap, role grants, triggers, and transaction rollback
  behavior.
- Running unit, PostgreSQL integration, concurrency, formatting, lint, typecheck, build, and
  production dependency audit gates.
- Inspecting Qodo findings and adding focused regressions for accepted issues.
- Making the native `Allow` and `Deny` decisions in the TrueForge UI.
- Independently verifying plan, audit, row, and public API state after those decisions.

## Safety Separation

The language model never supplies the repair candidate. The exact approved reducer derives it from
bounded immutable events. The model cannot bypass native approval, and approval cannot bypass the
transactional evidence recheck. No AI tool receives or prints provider keys, database passwords,
or private customer data as part of the submitted workflow.

## Known Limits

Model prose and tool selection can vary. Safety outcomes may not. External model and sandbox
providers can fail or exhaust quota; such failures are reported and never represented as successful
repair evidence. The repository documents external evidence separately from deterministic local
and PostgreSQL gates.
