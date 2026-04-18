# Decision Log

This file records early product and architecture decisions.

## D-001: Start with search, not agents

Decision:

- The first product is a machine search and recall tool, not an agent platform.

Reason:

- search pain is immediate and obvious
- easier to ship
- easier to trust
- creates a substrate for later agent use

## D-002: Local-first by default

Decision:

- the system should work locally by default

Reason:

- privacy
- trust
- speed
- good fit for Linux and power-user adoption

## D-003: User-space intelligence first

Decision:

- keep intelligence in user-space and delay system-level collectors

Reason:

- lower implementation risk
- easier iteration
- enough to prove value in V1

## D-004: Developer-machine wedge first

Decision:

- target developers and Linux power users first

Reason:

- strongest personal pain
- easiest initial distribution
- natural fit for repo indexing and CLI-first workflow

## D-005: Query should be grounded

Decision:

- every answer must show why it matched

Reason:

- trust is essential
- fuzzy semantic search can feel magical or fake
- grounded retrieval is a product differentiator

## D-006: Keep the first release narrow

Decision:

- V1 covers repos, files, PDFs, screenshots, images, and downloads

Reason:

- strong demos
- enough breadth to feel useful
- small enough to build

## D-007: Preserve raw evidence

Decision:

- extracted metadata and text should keep clear linkage to original sources

Reason:

- future debugging
- trust
- auditability
- better enrichment later

## D-008: Use Machine Memory as the working name

Decision:

- the working product name is `Machine Memory`

Reason:

- clear and direct
- broad enough for the long-term vision
- good enough to move forward without blocking on branding

## D-009: Use TypeScript and Node.js for V1

Decision:

- V1 should be built with TypeScript on Node.js

Reason:

- strong local tooling ecosystem
- mature CLI and filesystem libraries
- easier access to SQLite, git, and OCR integrations
- lower risk than optimizing for Bun too early

## D-010: Use SQLite and FTS5 as the first retrieval backbone

Decision:

- use SQLite for metadata storage and FTS5 for local full-text search

Reason:

- simple local deployment
- inspectable storage
- good enough power for V1
- avoids introducing a separate search service too early

## D-011: Delay semantic retrieval until after baseline search works

Decision:

- do not make embeddings or semantic retrieval mandatory for the first useful release

Reason:

- exact, fuzzy, OCR, and full-text search already solve a lot of pain
- simpler retrieval is easier to debug and trust
- semantic ranking can be added once the baseline UX is already strong

## D-012: Default OCR to screenshots first

Decision:

- V1 should default OCR to `screenshots` mode instead of OCRing every image file

Reason:

- screenshot OCR is high value early
- OCR on every image makes scans much slower
- explicit OCR modes keep the product predictable and controllable

## D-013: Use optional EXIF extraction when exiftool is available

Decision:

- image metadata extraction should opportunistically use `exiftool` when it exists, but not require it to function

Reason:

- EXIF-backed image recall is important for the long-term vision
- optional enrichment keeps setup simple
- the baseline product should still work even without extra metadata tooling

## D-014: Remove the per-root file cap in Phase 1

Decision:

- Phase 1 scanning should not silently cap each root at an arbitrary file limit

Reason:

- hidden caps make "scan this root" incomplete and untrustworthy
- exclusion rules and incremental fingerprints are a better control surface than silent truncation
- Phase 1 needs to answer "where is it?" honestly, even on larger roots

## D-015: Make typo-tolerant recall part of the baseline

Decision:

- imperfect-name recall is part of the Phase 1 baseline, not a later enhancement

Reason:

- users often remember names approximately
- repo recall feels broken if `gitinsteroid` cannot find `gitonsteroid`
- lightweight fuzzy matching is enough to prove the product value before semantic retrieval exists

## D-019: Collapse the staged phase ship into one always-on product

Decision:

- Stop treating the six phases as semi-independent ship frames. Build one product — a local always-on daemon plus thin CLI plus embedded MCP server — installed by `npx machine-memory init`. Each phase fills a layer of that product, not a separate tool.

Reason:

- The end goal was always a single substrate that grounds humans and AI on the machine they share (see D-018 and `docs/01-product-thesis.md`). Shipping that substrate in six semi-independent frames paid a coordination cost every time a later phase had to compose with an earlier one, and left the product in pieces that each required separate adoption work.
- "Agents first, humans second" is impossible to honor when the agent interface is a Phase 5 integration. The MCP server has to be first-class from the first real ship after Phase 0.
- Realtime indexing is not a polish item — it is what the product IS. Treating it as Phase 6 contradicted the north star.
- The research synthesized in `docs/22-phase-2-research.md` (activity events, MCP tool schemas, sqlite-vec, SQLite pragmas) and the pivot synthesis in `docs/23-product-v2-architecture.md` (knowledge graph, LLM-as-compiler wiki, contextual retrieval, install contract) together make the unified architecture concrete enough to build without further staging.

How this is applied:

- `docs/23-product-v2-architecture.md` is the canonical architecture reference. `docs/06-roadmap-phases.md` is rewritten so each phase is a layer of the same daemon/CLI/MCP product.
- F-010 (scheduled scans) and F-011 (delete/rename via scan diff) are closed as superseded by the daemon.
- F-009's follow-up (extraction out of transaction, worker-pool extractors) is retained and moves into Phase 1 of the v2 roadmap — the daemon needs it to keep up under realtime load.
- Every design review from here checks the proposal against both the human path AND the agent path (per D-018), not just the human path first.

## D-018: AI agents are a first-class user, not a downstream integration

Decision:

- Treat AI agents running on the user's machine as a primary user of Machine Memory, alongside the human who owns the machine
- Every phase must be evaluated against both paths: does it make human recall better, and does it make agent grounding better?

Reason:

- the machine's AI tools today waste tokens on blind `grep`/`glob`/file-read loops because there is no retrieval layer that is already right
- a well-built local retrieval substrate for humans is already most of what agents need for grounded context
- framing agents as a downstream "Phase 5 integration" invited design choices that would have served humans well but made later agent grounding harder (loose provenance, opaque ranking, no stable retrieval surface)
- naming agents as a first-class user keeps the retrieval substrate honest from Phase 1 forward

How this is applied:

- provenance and "why matched" output, already required for human trust (D-005), now also serves as the evidence surface that lets agents cite what they used
- retrieval APIs and data shapes should stay stable enough that the Phase 5 interface is a thin adapter, not a rewrite
- Phase 2+ design reviews check both paths explicitly instead of only the human path

## D-017: Separate file-record fingerprint from extraction state

Decision:

- the incremental scan cache must not treat "file record has been seen" as equivalent to "file has been fully extracted"

Reason:

- the original Phase 1 cache skipped a file entirely when its path/size/mtime fingerprint matched the last scan
- this caused files indexed before PDF extraction was wired to permanently stay unindexed for text recall, even on rescans
- a rescan of the real machine found that only 2 of 88 PDFs and 0 of 14 DOCX files had extracted text, despite the relevant extractors being available
- a cache that reports success without ever producing the artifact is a fake-completion pattern that contradicts the product's trust promise

How this is applied:

- scanner rechecks the expected text extractor type for a file whenever its fingerprint matches, and re-runs extraction when the expected text blob is missing
- this keeps the incremental cache cheap for files that are already fully extracted, while automatically healing partial or stale extraction state

## D-016: Validate with real local content, not only mocked fixtures

Decision:

- Phase 1 completion requires real machine-grounded validation in addition to unit tests

Reason:

- local search products can pass synthetic tests and still feel wrong in practice
- real screenshots, PDFs, images, and repos reveal ranking and provenance problems that fixtures miss
- future sessions need a durable record of the exact proof queries that justified the Phase 1 completion call
