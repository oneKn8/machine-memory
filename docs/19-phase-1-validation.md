# Phase 1 Validation Notes

This file records the real-world validation that justified calling Phase 1 complete.

The goal was not just to pass unit tests, but to prove that the tool can answer real "where is that thing?" queries on this machine.

## Validation Setup

Validation was run with:

- actual local git repositories
- actual local screenshot content
- actual local PDF content
- actual local image content

To keep the validation scan fast and deterministic, a small controlled root was created from copies of real local files:

- `.validation-real/screenshots/Screenshot from 2026-04-01 19-07-04.png`
- `.validation-real/docs/Analysis of Sorting Algorithms - Project Report.pdf`
- `.validation-real/images/SCOUT_Build_Roadmap_Flowchart.png`

These files came from the machine's real `Pictures` and `Documents` content, but were scanned in a small dedicated root so Phase 1 could be validated without OCR-crawling the entire picture library.

## Commands Run

### Repo scan

```bash
npm run scan -- --root /home/oneknight/zCoursework --ocr-mode off
```

### Real-content validation scan

```bash
npm run scan -- --root /home/oneknight/projects/machine-memory/.validation-real --ocr-mode screenshots
```

### Incremental repeat scan

```bash
npm run scan -- --root /home/oneknight/projects/machine-memory/.validation-real --ocr-mode screenshots
```

## Proof Queries

### 1. Imperfect repo recall

```bash
npm run find -- "gitinsteroid"
```

Observed top hit:

- `gitonsteroid`
- path: `/home/oneknight/zCoursework/gitonsteroid`
- why: similar repo name plus remote URL

This proved typo-tolerant repo recall.

### 2. Screenshot OCR recall

```bash
npm run find -- "Scanned 20 MCP Server Configs for Security Vulnerabilities"
```

Observed top hit:

- `Screenshot from 2026-04-01 19-07-04.png`
- path: `.validation-real/screenshots/...`
- why: screenshot OCR text

This proved screenshot recall by visible text, not just filename.

### 3. PDF recall by topic/content

```bash
npm run find -- "xss3m stack size sorting algorithms"
```

Observed top hit:

- `Analysis of Sorting Algorithms - Project Report.pdf`
- path: `.validation-real/docs/...`
- why: PDF text

This proved document recall by extracted content.

### 4. Image recall

```bash
npm run find -- "roadmap flowchart"
```

Observed top hit:

- `SCOUT_Build_Roadmap_Flowchart.png`
- path: `.validation-real/images/...`
- why: image metadata and file/path cues

This proved image recall on real local content.

### 5. Incremental scan proof

Second scan output for the same validation root:

- `Indexed files: 0`
- `Reused unchanged files: 3`
- `Text extractions: 0`
- `Metadata extractions: 0`
- `OCR extractions: 0`

This proved that unchanged files are skipped and extraction work is reused.

## Practical Notes

- Full-picture-root OCR can still be expensive. For Phase 1, this is acceptable because OCR mode is explicit and controllable.
- Real-world validation revealed that ranking needed to favor OCR/metadata evidence more strongly and needed to demote noisy temp/dependency paths.
- Real-world validation also justified making typo recall part of the baseline instead of treating it as a future enhancement.

## Phase 1 Conclusion

Phase 1 successfully answers:

- "Where is that repo?"
- "Where is that screenshot?"
- "Where is that PDF?"
- "Where is that file/image?"

with grounded explanations, local-only storage, and incremental rescans.

## Phase 1 Reopen (2026-04-17)

Phase 1 was reopened after real-machine testing revealed three gaps that the original validation missed because the original proof set was a 3-file controlled root, not the broader index:

1. **PDF body extraction coverage was effectively 2%.** Only 2 of 88 indexed PDFs had text blobs, because the incremental scan cache was skipping any file with a matching path/size/mtime fingerprint without checking whether extraction had actually produced content. Files indexed before PDF extraction was wired stayed unindexed for text recall forever.
2. **DOCX body extraction was not wired at all.** 0 of 14 DOCX files had text blobs. `.docx` was not a detected kind.
3. **Vague natural-language queries returned only recent repos.** "a book about stats" returned 10 repos and 0 files even though stat-related PDFs, DOCX files, and markdown notes exist. The ranker gave repos a +20 base bias, token `LIKE` matching had no stop-word filter, there was no stemming, and fuzzy similarity compared the full long query to short file names.

### Reopen Fixes

- `src/scanner/fileScanner.ts` now re-runs text extraction when the fingerprint matches but the expected text blob is missing (`expectedTextExtractorType` + `hasTextBlob`).
- `src/extractors/textExtractor.ts` detects `.docx`, extracts text via `unzip -p <file> word/document.xml` plus XML tag/entity stripping, and reports `application/docx` as the extractor type.
- `src/search/find.ts` drops a small linguistic stop-word list from token matching, applies plural-`s` soft stemming for tokens ≥ 4 characters, separates file name search from file path search (so name matches are not drowned by recent path-only matches under a single `ORDER BY modified_at` limit), rewards word-boundary name matches more than substring matches, and uses per-token fuzzy similarity for multi-word queries while preserving whole-query fuzzy similarity for single-word typo recall. FTS strict-AND matches are flagged and given a token-count-scaled confidence boost so they still win over loose `OR` matches on precise queries like OCR text search.
- `src/cli/commands/doctor.ts` now reports whether `unzip` is available (required for DOCX extraction).

### Post-fix Coverage On Real Machine Data

After rescanning `~/Downloads`, `~/zCoursework`, and `~/Desktop` with the fix in place:

- PDFs with indexed text: **75 of 90 total** (was 2 of 88). The 15 remaining unextracted PDFs were all under `~/projects/**`, which could not be rescanned at the time due to the F-007 performance issue.
- DOCX files with indexed text: **11 of 14 total** (was 0 of 14). The 3 remaining DOCX files were also under `~/projects/**`.

### F-007 Resolved And Re-Validated Against `~/projects`

Once F-007 was rooted out (the scanner was wrapping the whole scan in a single 360 MB WAL-growing transaction, not actually hanging), the scanner was refactored to commit per batch and stream progress to stderr. After partial re-scanning `~/projects` with the fix:

- PDFs with indexed text: **91 of 93 total**
- DOCX files with indexed text: **13 of 14 total**

The remaining 3 files are all legitimate content limitations, not extractor bugs:

- `~/Pictures/project-assets/lumentra1.pdf` and `lumentra1 (1).pdf` — image-only PDFs; `pdftotext` correctly returns no text.
- `~/projects/infra/Astra/test-resume.docx` — 56 bytes of plain text with a `.docx` extension; not a real DOCX.

Effective extractable-content coverage is 100%.

### Validation Queries (Phase 1 Reopen)

Query: `mm find "Scanned 20 MCP Server Configs for Security Vulnerabilities"`

- Top hit: `Screenshot from 2026-04-01 19-07-04.png`
- Why: `Matched screenshot file name or path; Matched screenshot OCR text`
- No regression vs the original Phase 1 validation.

Query: `mm find "xss3m stack size sorting algorithms"`

- Top hit: `Analysis of Sorting Algorithms - Project Report.pdf`
- Why: PDF body match.
- No regression vs the original Phase 1 validation.

Query: `mm find "roadmap flowchart"`

- Top hit: `SCOUT_Build_Roadmap_Flowchart.png`
- No regression vs the original Phase 1 validation.

Query: `mm find "gitinsteroid"`

- Top hit: `gitonsteroid`
- No regression on D-015 (typo-tolerant repo recall).

Query: `mm find "stat hw"`

- Top 5: `stat hw6.md`, `Stat hw 3.docx`, `Stat hw 3.md`, `STAT_HW2_SOLUTIONS.md`, `STAT HW 2 QUESTIONS SET.pdf`
- All four stats homework files plus the DOCX surface together, confirming that DOCX extraction and PDF re-extraction are both working end-to-end on the user's actual machine content.

Query: `mm find "stats homework"`

- Top hits include `Homework Assignment 2(3).docx` and `Homework Assignment 1 (1).docx` alongside the stat markdown files — DOCX content and filename hits interleave correctly.

Query: `mm find "a book about stats"`

- Returns files (not only repos), including state/status files, stats files in source code, and stat homework markdown. The STAT HW PDF/DOCX do not appear at the very top because their content does not literally contain "book"; this is a natural-language ambiguity captured as followup F-008, not a regression.

### Gates Re-verified

- `npm test` — 35 tests pass
- `npm run typecheck` — clean
- `npm run build` — clean
- `npm run doctor` — all external tools found (including `unzip`)
