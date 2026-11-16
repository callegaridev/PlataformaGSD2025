CREATE TABLE IF NOT EXISTS storage_migration_runs (
  source_sha256 TEXT PRIMARY KEY,
  file_counts JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
