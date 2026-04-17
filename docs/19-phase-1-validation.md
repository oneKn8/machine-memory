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
