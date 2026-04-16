# Ingest Sources

## Principle

Index the highest-signal, lowest-complexity sources first.

Do not try to ingest every possible digital source in V1.

## Tier 1 Sources

These should be in the first release:

- local repos
- local files
- README files
- package manifests
- Markdown docs
- text files
- PDFs
- screenshots
- images with EXIF metadata
- downloads

Why:

- high utility
- relatively low privacy risk
- easy to explain
- strong demos

## Tier 2 Sources

These should come after V1:

- shell history
- recent file activity
- project-level notes
- daily logs
- browser downloads history

Why:

- strong value for work resurrection
- moderate complexity

## Tier 3 Sources

These should come later:

- browser history
- calendar exports
- phone exports
- task systems
- chat exports
- bookmarks

Why:

- higher privacy sensitivity
- more normalization work
- less important for first wedge

## Tier 4 Sources

These are future platform expansions:

- process events
- live filesystem streams
- service logs
- app-specific integrations
- near-real-time machine telemetry

## Source-Specific Notes

### Git Repos

Extract:

- root path
- remote URLs
- branch info
- recent activity
- README and manifest hints

### PDFs

Extract:

- title
- text
- page count
- keywords if available

### Images

Extract:

- filename
- timestamps
- dimensions
- EXIF metadata
- OCR text where useful

### Screenshots

Treat as special images:

- OCR is especially important
- app/context hints may matter later

## Exclusions

The system must support exclusions early:

- directories
- glob patterns
- hidden paths if desired
- sensitive roots

This is important for trust and performance.
