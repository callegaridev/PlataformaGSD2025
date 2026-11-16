CREATE TABLE IF NOT EXISTS storage_migration_runs (
  source_sha256 TEXT PRIMARY KEY,
  file_counts TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
