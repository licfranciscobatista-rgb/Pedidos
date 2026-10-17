CREATE TABLE IF NOT EXISTS auth_owner (
  id integer PRIMARY KEY CHECK (id=1),
  username text NOT NULL UNIQUE,
  data_owner_id uuid NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at bigint NOT NULL,
  setup_consumed_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash)=64),
  owner_id integer NOT NULL REFERENCES auth_owner(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  action text PRIMARY KEY CHECK (action IN ('login','setup')),
  window_started_at bigint NOT NULL,
  attempts integer NOT NULL CHECK (attempts>0)
);
