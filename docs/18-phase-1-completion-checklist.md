# Phase 1 Completion Checklist

This checklist defines the remaining work required before Phase 1 can be called complete with confidence.

Phase 1 is not just "it works on my machine."
It is complete when it is fast enough, trustworthy enough, and repeatable enough to serve as the foundation for the later memory and timeline phases.

## Completion Criteria

- [x] `mm scan` avoids rescanning unchanged files by using a stable scan fingerprint such as `path + size + mtime` or an equivalent change detector
- [x] OCR and text extraction are cached so repeated scans do not redo work unnecessarily
- [x] Exclusion rules are configurable and cover noisy paths like build directories, dependency trees, caches, vendored artifacts, and temporary folders
- [x] Scan roots are configurable from a user-editable config file and can still be overridden per command
- [x] Ranking is cleaned up so likely user-owned results beat noisy vendor, dependency, and unrelated matches
- [x] `mm show` explains results with enough provenance to trust them, including extraction source, match type, and relevant metadata
- [x] OCR-backed and metadata-backed results are clearly labeled so users can tell why an image or screenshot matched
- [x] Search quality is validated on real local data, not just synthetic fixtures
- [x] Repo recall, PDF recall, screenshot OCR recall, and image recall all work on actual machine content
- [x] The tool remains local-first, rerunnable, and inspectable on disk after all of the above changes

## Hardening Tasks

### 1. Incremental Scan Caching

- [x] Record enough per-file identity to skip unchanged files on future scans
- [x] Persist scan state so repeated scans become incremental instead of brute-force
- [x] Keep cache invalidation understandable and conservative

### 2. Exclusions And Config

- [x] Add a stable config file format for roots, excludes, and OCR behavior
- [x] Make excludes easy to reason about and easy to override
- [x] Ensure noisy directories are skipped by default without surprising the user

### 3. Ranking Cleanup

- [x] Reduce noise from large dependency trees and generated folders
- [x] Boost likely user-owned repos, recent work, and strong source matches
- [x] Keep fuzzy matches useful without letting them dominate obvious exact results

### 4. Provenance And Trust

- [x] Show where each result came from
- [x] Show whether a hit came from path, repo metadata, document text, OCR text, or EXIF/metadata
- [x] Surface enough detail in `mm show` for a user to verify the match quickly

### 5. Real-World Validation

- [x] Run the tool against actual repos, PDFs, screenshots, and downloaded files from this machine
- [x] Keep a small regression set of representative search cases
- [x] Verify that search quality still feels good after changes to crawling, caching, or ranking

## Phase 1 Exit Statement

Phase 1 is done when the project can reliably answer:

- "Where is that repo?"
- "Where is that screenshot?"
- "Where is that PDF?"
- "Where is that file?"

and do so quickly, with grounded explanations, without rescanning everything every time.

## Reopen Notes (2026-04-17)

The items above were initially checked off against a 3-file controlled validation root. Testing on the real machine index surfaced three real gaps — two of which made previously-checked items untrue in practice:

- "Repo recall, PDF recall, screenshot OCR recall, and image recall all work on actual machine content" was checked, but only 2 of 88 indexed PDFs and 0 of 14 indexed DOCX files actually had extracted text. Root cause: the incremental scan cache skipped previously-seen files without verifying that extraction had produced a blob. See D-017 and [20-phase-1-followups.md](20-phase-1-followups.md).
- "Keep fuzzy matches useful without letting them dominate obvious exact results" was checked, but natural-language queries with stop words and plural tokens were drowning file matches under recent repos.

Both items have now been fixed and re-validated against the real index. PDF coverage is 75 of 90 indexed PDFs and DOCX coverage is 11 of 14 (the gap is bounded to files under `~/projects/**` which could not be rescanned this pass due to followup F-007). See `docs/19-phase-1-validation.md` for the full Phase 1 Reopen validation record.
