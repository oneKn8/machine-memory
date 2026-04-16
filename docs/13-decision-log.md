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
