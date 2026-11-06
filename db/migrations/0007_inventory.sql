CREATE TABLE inventory_primary (
 owner_id text PRIMARY KEY,
 device_id text NOT NULL,
 version bigint NOT NULL DEFAULT -1,
 state_json jsonb,
 state_hash text NOT NULL DEFAULT '',
 last_seen timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inventory_commands (
 owner_id text NOT NULL,
 id text NOT NULL,
 payload_json jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','rejected','expired')),
 result_json jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 seconds'),
 PRIMARY KEY(owner_id,id)
);
CREATE INDEX inventory_commands_pending ON inventory_commands(owner_id,status,created_at);
