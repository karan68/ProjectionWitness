CREATE TABLE projection_repair_plans (
    plan_id uuid PRIMARY KEY,
    schema_version integer NOT NULL CHECK (schema_version = 1),
    projection_name text NOT NULL,
    stream_id text NOT NULL,
    stream_head_version integer NOT NULL CHECK (stream_head_version >= 0),
    event_count integer NOT NULL CHECK (event_count >= 0),
    stream_sha256 text NOT NULL CHECK (stream_sha256 ~ '^[0-9a-f]{64}$'),
    runtime_generation bigint NOT NULL CHECK (runtime_generation > 0),
    reducer_sha256 text NOT NULL CHECK (reducer_sha256 ~ '^[0-9a-f]{64}$'),
    source_commit_sha text NOT NULL CHECK (length(btrim(source_commit_sha)) > 0),
    current_row_version bigint NOT NULL CHECK (current_row_version > 0),
    current_row_sha256 text NOT NULL CHECK (current_row_sha256 ~ '^[0-9a-f]{64}$'),
    current_row jsonb NOT NULL CHECK (jsonb_typeof(current_row) = 'object'),
    candidate_row_sha256 text NOT NULL CHECK (candidate_row_sha256 ~ '^[0-9a-f]{64}$'),
    candidate_row jsonb NOT NULL CHECK (jsonb_typeof(candidate_row) = 'object'),
    evidence_sha256 text NOT NULL UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('PREPARED', 'APPLIED')),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    applied_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK (
        current_row ?& ARRAY['totalCents', 'paidCents']
        AND candidate_row ?& ARRAY['totalCents', 'paidCents']
        AND (current_row->>'totalCents') ~ '^(0|[1-9][0-9]*)$'
        AND (current_row->>'paidCents') ~ '^(0|[1-9][0-9]*)$'
        AND (candidate_row->>'totalCents') ~ '^(0|[1-9][0-9]*)$'
        AND (candidate_row->>'paidCents') ~ '^(0|[1-9][0-9]*)$'
        AND (current_row->>'totalCents')::numeric <= 9007199254740991
        AND (current_row->>'paidCents')::numeric <= 9007199254740991
        AND (candidate_row->>'totalCents')::numeric <= 9007199254740991
        AND (candidate_row->>'paidCents')::numeric <= 9007199254740991
    ),
    CHECK (
        (status = 'PREPARED' AND applied_at IS NULL)
        OR (status = 'APPLIED' AND applied_at IS NOT NULL)
    )
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pw_repair_executor') THEN
        CREATE ROLE pw_repair_executor LOGIN;
    END IF;
END;
$$;

CREATE TABLE projection_repair_audit (
    audit_id uuid PRIMARY KEY,
    plan_id uuid NOT NULL UNIQUE REFERENCES projection_repair_plans(plan_id),
    projection_name text NOT NULL,
    stream_id text NOT NULL,
    before_row jsonb NOT NULL CHECK (jsonb_typeof(before_row) = 'object'),
    before_row_sha256 text NOT NULL CHECK (before_row_sha256 ~ '^[0-9a-f]{64}$'),
    after_row jsonb NOT NULL CHECK (jsonb_typeof(after_row) = 'object'),
    after_row_sha256 text NOT NULL CHECK (after_row_sha256 ~ '^[0-9a-f]{64}$'),
    stream_sha256 text NOT NULL CHECK (stream_sha256 ~ '^[0-9a-f]{64}$'),
    reducer_sha256 text NOT NULL CHECK (reducer_sha256 ~ '^[0-9a-f]{64}$'),
    runtime_generation bigint NOT NULL CHECK (runtime_generation > 0),
    trueforge_session_id text,
    trueforge_turn_id text,
    trueforge_tool_call_id text,
    correlation_trust text NOT NULL DEFAULT 'SUPPLIED' CHECK (correlation_trust = 'SUPPLIED'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    receipt_sha256 text NOT NULL UNIQUE CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION restrict_projection_repair_plan_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status <> 'PREPARED'
        OR NEW.status <> 'APPLIED'
        OR NEW.applied_at IS NULL
        OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
        OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.projection_name IS DISTINCT FROM OLD.projection_name
        OR NEW.stream_id IS DISTINCT FROM OLD.stream_id
        OR NEW.stream_head_version IS DISTINCT FROM OLD.stream_head_version
        OR NEW.event_count IS DISTINCT FROM OLD.event_count
        OR NEW.stream_sha256 IS DISTINCT FROM OLD.stream_sha256
        OR NEW.runtime_generation IS DISTINCT FROM OLD.runtime_generation
        OR NEW.reducer_sha256 IS DISTINCT FROM OLD.reducer_sha256
        OR NEW.source_commit_sha IS DISTINCT FROM OLD.source_commit_sha
        OR NEW.current_row_version IS DISTINCT FROM OLD.current_row_version
        OR NEW.current_row_sha256 IS DISTINCT FROM OLD.current_row_sha256
        OR NEW.current_row IS DISTINCT FROM OLD.current_row
        OR NEW.candidate_row_sha256 IS DISTINCT FROM OLD.candidate_row_sha256
        OR NEW.candidate_row IS DISTINCT FROM OLD.candidate_row
        OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'repair plan evidence is immutable';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM projection_repair_audit
        WHERE plan_id = OLD.plan_id
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'repair plan cannot complete without an audit row';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER projection_repair_plan_updates_are_restricted
BEFORE UPDATE ON projection_repair_plans
FOR EACH ROW
EXECUTE FUNCTION restrict_projection_repair_plan_update();

CREATE FUNCTION reject_projection_repair_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'projection repair audit is append-only';
END;
$$;

CREATE TRIGGER projection_repair_audit_is_append_only
BEFORE UPDATE OR DELETE ON projection_repair_audit
FOR EACH ROW
EXECUTE FUNCTION reject_projection_repair_audit_mutation();

CREATE FUNCTION reject_repair_role_lock_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_user = 'pw_repair_executor' THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'repair role may lock but not mutate this row';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER repair_role_cannot_mutate_projection_runtime
BEFORE UPDATE ON projection_runtime
FOR EACH ROW
EXECUTE FUNCTION reject_repair_role_lock_row_mutation();

CREATE TRIGGER repair_role_cannot_mutate_event_streams
BEFORE UPDATE ON event_streams
FOR EACH ROW
EXECUTE FUNCTION reject_repair_role_lock_row_mutation();

REVOKE ALL ON projection_repair_plans, projection_repair_audit FROM PUBLIC;

GRANT SELECT ON projection_repair_plans, projection_repair_audit TO pw_mcp_read;

GRANT USAGE ON SCHEMA public TO pw_repair_executor;
GRANT SELECT, INSERT ON projection_repair_plans TO pw_mcp_write;

GRANT SELECT, UPDATE ON projection_repair_plans TO pw_repair_executor;
GRANT SELECT, INSERT ON projection_repair_audit TO pw_repair_executor;
GRANT SELECT ON projection_runtime, event_streams, events, order_view TO pw_repair_executor;
GRANT UPDATE (projection_name) ON projection_runtime TO pw_repair_executor;
GRANT UPDATE (stream_id) ON event_streams TO pw_repair_executor;
GRANT UPDATE (
    total_cents,
    paid_cents,
    payment_status,
    fulfillment_status,
    last_stream_version,
    row_version,
    updated_at
) ON order_view TO pw_repair_executor;