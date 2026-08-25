CREATE TABLE projection_checkpoints (
    projection_name text PRIMARY KEY,
    last_global_position bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE projection_gaps (
    projection_name text NOT NULL REFERENCES projection_checkpoints(projection_name),
    global_position bigint NOT NULL,
    first_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (projection_name, global_position)
);

CREATE TABLE order_view (
    order_id text PRIMARY KEY,
    total_cents bigint NOT NULL CHECK (total_cents >= 0),
    paid_cents bigint NOT NULL CHECK (paid_cents >= 0),
    payment_status text NOT NULL CHECK (
        payment_status IN ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'PAID')
    ),
    fulfillment_status text NOT NULL CHECK (
        fulfillment_status IN ('NOT_SHIPPED', 'SHIPPED')
    ),
    last_stream_version integer NOT NULL CHECK (last_stream_version > 0),
    row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON projection_checkpoints, projection_gaps, order_view FROM PUBLIC;

GRANT SELECT ON order_view TO pw_api;

GRANT SELECT, INSERT, UPDATE ON projection_checkpoints TO pw_projector;
GRANT SELECT, INSERT, UPDATE, DELETE ON projection_gaps TO pw_projector;
GRANT SELECT, INSERT, UPDATE ON order_view TO pw_projector;

GRANT SELECT ON projection_checkpoints, projection_gaps, order_view TO pw_mcp_read;
GRANT SELECT ON projection_checkpoints, projection_gaps, order_view TO pw_mcp_write;