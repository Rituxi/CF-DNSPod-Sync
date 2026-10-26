-- Add ownership without rewriting the migration already applied in production.
ALTER TABLE tool_control ADD COLUMN sync_owner TEXT;
ALTER TABLE tool_control ADD COLUMN probe_owner TEXT;
