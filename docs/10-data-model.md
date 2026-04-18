# Data Model

## Goal

Keep the data model simple, inspectable, and extensible.

The first version should model concrete machine artifacts before trying to model abstract memories.

## Core Record Types

### FileRecord

Represents a file on disk.

Suggested fields:

- `id`
- `path`
- `name`
- `extension`
- `mime_type`
- `size_bytes`
- `created_at`
- `modified_at`
- `accessed_at`
- `sha256` or other content hash when useful — not yet implemented; planned for Phase 2 per `docs/22-phase-2-research.md` §4 (rename detection, F-011).
- `source_root`
- `text_content_ref`
- `ocr_content_ref`
- `embedding_ref`
- `metadata_json`

Implemented columns as of Phase 1: `id, path, name, extension, mime_type, size_bytes, created_at, modified_at, accessed_at, source_root, metadata_json` (see `src/index/schema.ts`). Text, OCR, and (future) embeddings are stored in `text_blobs` keyed by `source_id`, not in inline refs — the `_ref` names above remained in the spec but the schema uses a single sidecar table per D-007.

### DirectoryRecord

Represents a directory worth surfacing directly.

Suggested fields:

- `id`
- `path`
- `name`
- `parent_path`
- `modified_at`
- `directory_type`
- `metadata_json`

### RepoRecord

Represents a git repository.

Suggested fields:

- `id`
- `root_path`
- `repo_name`
- `remote_url`
- `default_branch`
- `current_branch`
- `last_commit_at`
- `readme_text_ref`
- `manifest_text_ref`
- `topics_json`
- `metadata_json`

### TextBlob

Represents extracted text from a source.

Suggested fields:

- `id`
- `source_id`
- `source_type`
- `extractor_type`
- `content`
- `language`
- `created_at`

### EmbeddingRecord

Represents semantic embedding data.

Suggested fields:

- `id`
- `source_id`
- `source_type`
- `model_name`
- `vector_ref`
- `created_at`

### RelationshipRecord

Represents inferred or explicit connections.

Suggested fields:

- `id`
- `from_id`
- `from_type`
- `to_id`
- `to_type`
- `relationship_type`
- `confidence`
- `evidence_json`

## V1 Query Model

### Query

Suggested fields:

- `raw_query`
- `normalized_query`
- `intent_type`
- `source_filters`
- `time_filters`
- `entity_hints`

### SearchResult

Suggested fields:

- `result_id`
- `result_type`
- `path`
- `title`
- `score`
- `why_matched`
- `last_modified`
- `related_ids`

## Future Record Types

Do not implement these until they are needed:

- `EventRecord` — promoted for Phase 2 as `activity_events`. Concrete schema and ingester order in `docs/22-phase-2-research.md` §2. Remove this bullet when the table ships.
- `CommandRecord` — absorbed into `activity_events` via `kind='shell_command'` per the Phase 2 plan. No separate table.
- `MemoryRecord` — Phase 4 (memory layer).
- `DailyLogRecord` — Phase 4.
- `PhoneRecord` — Phase 4 or later; tier 3 per `docs/12-ingest-sources.md`.
- `TimelineCluster` — derived view over `activity_events` once sessions land, likely Phase 2.5 or Phase 3.

## Data Model Principles

- Prefer concrete records over vague abstractions
- Keep raw evidence
- Add enrichment as sidecar data
- Separate extraction from retrieval
- Preserve source traceability
