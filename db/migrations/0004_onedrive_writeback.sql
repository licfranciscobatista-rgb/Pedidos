ALTER TABLE onedrive_connections ADD COLUMN granted_scope text NOT NULL DEFAULT '';
ALTER TABLE onedrive_connections ADD COLUMN last_write_at text NOT NULL DEFAULT '';
CREATE TABLE onedrive_write_jobs (
 owner_id text PRIMARY KEY NOT NULL,
 file_id text NOT NULL,
 source_etag text NOT NULL,
 target_hash text NOT NULL,
 snapshot_json text NOT NULL,
 connection_revision integer NOT NULL,
 created_at text NOT NULL
);
CREATE TABLE onedrive_output_baselines (
 owner_id text NOT NULL,
 file_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('invoice')),
 id text NOT NULL,
 fingerprint text NOT NULL,
 PRIMARY KEY(owner_id,file_id,kind,id)
);
