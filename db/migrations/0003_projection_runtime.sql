CREATE TABLE projection_runtime (
    projection_name text PRIMARY KEY,
    generation bigint NOT NULL CHECK (generation > 0),
    reducer_sha256 text NOT NULL CHECK (reducer_sha256 ~ '^[0-9a-f]{64}$'),
    source_commit_sha text NOT NULL CHECK (length(btrim(source_commit_sha)) > 0),
    algorithm_version text NOT NULL CHECK (length(btrim(algorithm_version)) > 0),
    gap_strategy text NOT NULL CHECK (length(btrim(gap_strategy)) > 0),
    registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON projection_runtime FROM PUBLIC;

GRANT SELECT ON projection_runtime TO pw_api;
GRANT SELECT, INSERT, UPDATE ON projection_runtime TO pw_projector;
GRANT SELECT ON projection_runtime TO pw_mcp_read;
GRANT SELECT ON projection_runtime TO pw_mcp_write;