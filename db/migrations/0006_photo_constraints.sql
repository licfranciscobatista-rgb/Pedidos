-- Preserve the checksum of 0005 for databases where it is already applied.
-- Invalid pre-existing records fail this migration instead of being deleted.
ALTER TABLE photos ADD CONSTRAINT photos_owner_valid
  CHECK (owner_id ~ '^[a-zA-Z0-9_-]{1,100}$');
ALTER TABLE photos ADD CONSTRAINT photos_key_valid
  CHECK (key ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$');
ALTER TABLE photos ADD CONSTRAINT photos_content_type_valid
  CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE photos ADD CONSTRAINT photos_size_valid
  CHECK (octet_length(data) BETWEEN 1 AND 5242880);
