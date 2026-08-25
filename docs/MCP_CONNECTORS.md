# MCP Connectors

Last verified: 2026-08-25

## Scope

Projection Witness exposes two loopback-only Streamable HTTP MCP connectors. The split keeps the
destructive tool off the investigation connector and gives TrueForge one exact operation on which
to require native human approval.

The read connector at `http://127.0.0.1:8781/mcp` publishes:

- `find_projection_case`
- `get_public_order_state`
- `inspect_projection_case`
- `snapshot_event_stream`
- `get_projection_runtime`
- `stage_projection_repair`
- `verify_projection_repair`

The write connector at `http://127.0.0.1:8782/mcp` publishes only
`apply_projection_repair`. It is marked destructive and idempotent. Plan staging is
non-destructive but persists an immutable prepared plan after authoritative evidence
revalidation.

`verify_projection_repair` accepts only a plan ID. It resolves the authoritative order ID from
the persisted plan and uses that same ID for the projection row and public API reads, so a caller
cannot combine plan/audit evidence for one order with verification state from another.

## Database Identities

The process requires three independent database URLs:

- `DATABASE_URL_MCP_READ` reads bounded investigation, plan, and audit evidence.
- `DATABASE_URL_MCP_WRITE` revalidates evidence and inserts prepared plans. It cannot mutate a
  projection row, audit, runtime, or stream.
- `DATABASE_URL_REPAIR_EXECUTOR` is not exposed as an MCP tool credential. The repair service uses
  it internally for the fixed lock, compare-and-swap, audit, and plan-completion transaction.

There is no arbitrary SQL, identifier, table, or column input. All queries are fixed and
parameterized. Event counts and serialized bytes are checked in PostgreSQL before event payloads
are loaded. Public API responses are streamed through a 1 MiB cap before JSON parsing. Errors
returned to MCP callers use stable codes and omit database, network, and stack details.

## Run And Verify

Set the three database URLs, `API_BASE_URL`, and the approved content-addressed
`REDUCER_BUNDLE_PATH`, then start both connectors:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run dev:mcp
```

In a second terminal, verify the live endpoints with the pinned official MCP client:

```powershell
& "C:\dev\.tools\node-v22.23.2-win-x64\npm.cmd" run mcp:smoke
```

The smoke command refuses a tool-list mismatch. Both servers bind only to `127.0.0.1`, reject
untrusted `Host` headers, cap JSON request bodies at 1 MiB, use a fresh stateless server and
transport per POST, and return `405` for other methods.

## Approval Boundary

`apply_projection_repair` requires the exact plan ID, stream/runtime/row/reducer hashes and
versions, evidence hash, and canonical expiry approved by the human. TrueForge correlation IDs
are optional audit context; they do not replace any evidence comparison. PostgreSQL rechecks the
live state under locks and returns a stale or expired outcome with zero repair writes when the
approved proof no longer matches.