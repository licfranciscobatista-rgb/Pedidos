CREATE TABLE IF NOT EXISTS photos (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, key)
);
