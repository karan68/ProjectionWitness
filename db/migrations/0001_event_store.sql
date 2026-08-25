CREATE SEQUENCE event_global_position_seq AS bigint CACHE 1;

CREATE TABLE event_streams (
    stream_id text PRIMARY KEY,
    aggregate_type text NOT NULL,
    version integer NOT NULL CHECK (version >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE events (
    event_id uuid PRIMARY KEY,
    global_position bigint NOT NULL DEFAULT nextval('event_global_position_seq'),
    stream_id text NOT NULL REFERENCES event_streams(stream_id),
    stream_version integer NOT NULL CHECK (stream_version > 0),
    event_type text NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (global_position),
    UNIQUE (stream_id, stream_version)
);

CREATE INDEX events_stream_order_idx ON events (stream_id, stream_version);

CREATE FUNCTION reject_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'events are immutable';
END;
$$;

CREATE TRIGGER events_are_immutable
BEFORE UPDATE OR DELETE ON events
FOR EACH ROW
EXECUTE FUNCTION reject_event_mutation();

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pw_api') THEN
        CREATE ROLE pw_api NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pw_projector') THEN
        CREATE ROLE pw_projector NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pw_mcp_read') THEN
        CREATE ROLE pw_mcp_read NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pw_mcp_write') THEN
        CREATE ROLE pw_mcp_write NOLOGIN;
    END IF;
END;
$$;

REVOKE ALL ON event_streams, events FROM PUBLIC;
REVOKE ALL ON SEQUENCE event_global_position_seq FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO pw_api;
GRANT SELECT, INSERT, UPDATE ON event_streams TO pw_api;
GRANT SELECT, INSERT ON events TO pw_api;
GRANT USAGE, SELECT ON SEQUENCE event_global_position_seq TO pw_api;