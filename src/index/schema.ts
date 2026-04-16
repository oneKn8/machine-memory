export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS file_records (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  extension TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TEXT,
  modified_at TEXT,
  accessed_at TEXT,
  source_root TEXT,
  metadata_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS repo_records (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  repo_name TEXT NOT NULL,
  remote_url TEXT,
  current_branch TEXT,
  last_commit_at TEXT,
  metadata_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS text_blobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  extractor_type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS text_blobs_fts USING fts5(
  source_id UNINDEXED,
  source_type UNINDEXED,
  extractor_type UNINDEXED,
  content
);
`

