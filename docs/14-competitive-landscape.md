# Competitive Landscape

**Research date:** 2026-04-15
**Methodology:** Rule of 5 deep research -- 5 parallel research agents, 40+ web searches, 60+ projects analyzed
**Searches performed:** 44
**Sources cited:** 60+

## Executive Summary

Nobody ships what Machine Memory describes. The space has dozens of tools that each cover a slice -- screen recording, document Q&A, code search, photo management, note-taking memory -- but no single product combines filesystem crawling, git repo awareness, image/OCR search, semantic retrieval, and CLI-first local search into one tool.

The closest competitors are Rememex (60 stars, Windows-only) and Second Brain (454 stars, Windows-focused). Both are small, new, and platform-limited. The large players (Screenpipe, Khoj, QMD, PrivateGPT) solve adjacent problems but not the "where is that file/repo/image" problem.

The market signal is strong: Rewind AI proved demand then died (acquired by Meta), Microsoft Recall shipped and fumbled on privacy, Apple locked semantic search behind their ecosystem. There is a clear vacuum for a cross-platform, local-first, privacy-absolute answer engine for your machine.

---

## The Competitive Map

### Category 1: Screen Recording Memory (captures what you SEE)

These record your screen continuously and make the recorded content searchable via OCR.

| Tool | Stars | Local | OSS | Platforms | Status |
|------|-------|-------|-----|-----------|--------|
| Screenpipe | 18,200 | Yes | MIT | Mac/Win/Linux | Very active, $2.8M raised |
| Microsoft Recall | N/A | Yes | No | Win 11 (NPU only) | Shipped, troubled, may be reworked |
| Rewind AI / Limitless | N/A | Was | No | Was Mac | Dead -- acquired by Meta Dec 2025 |
| OpenRecall | 2,800 | Yes | AGPL | Mac/Win/Linux | Active, early |
| Windrecorder | 3,800 | Yes | GPL | Windows | Active, early |
| Littlebird | N/A | No | No | Mac/Win/mobile | Active, $11M raised, cloud-dependent |

**Key finding:** Screenpipe is the clear leader. Records screen + audio 24/7, OCR, Whisper transcription, 50+ automation plugins. 100K+ downloads. $400 lifetime or free self-host.

**Relevance to Machine Memory:** Complementary, not competitive. Screenpipe records what you see on screen. Machine Memory indexes what you have on disk. They answer different questions:
- Screenpipe: "What was I looking at last Tuesday?"
- Machine Memory: "Where is that repo/file/image?"

Screenpipe cannot find a file by path, a repo by remote, or an image by EXIF location. Machine Memory cannot recall what was visible on your screen yesterday.

---

### Category 2: Document Q&A / "Chat With Your Docs" (searches uploaded documents)

These let you upload documents and ask questions about them. None crawl your filesystem.

| Tool | Stars | Local | OSS | Crawls FS | Git Aware | OCR |
|------|-------|-------|-----|-----------|-----------|-----|
| RAGFlow | 78,200 | Docker | Yes | No | No | Best in class (DeepDoc) |
| Anything-LLM | 58,400 | Electron | Yes | No | No | Yes |
| PrivateGPT | 57,200 | Docker | Yes | No | No | Limited |
| Khoj | 34,100 | Both | AGPL | No | No | Via LLM |
| Onyx (Danswer) | 27,200 | Docker | MIT | No | GitHub cloud | Via lib |
| LocalGPT | 22,200 | Yes | Yes | No | No | No |

**Key finding:** These are all "upload and ask" tools. You must manually specify which documents to index. None of them walk your filesystem, detect git repos, read EXIF metadata, or answer "where is that file." They solve document comprehension, not file retrieval.

**Relevance to Machine Memory:** Different problem space. RAGFlow's DeepDoc OCR engine is worth studying as a dependency. Khoj is the closest in vision (personal AI search) but is note-centric, not machine-centric.

---

### Category 3: Semantic Code Search (searches WITHIN codebases)

These help developers search code by meaning, not just grep.

| Tool | Stars | Local | Scope | MCP | Git Repos |
|------|-------|-------|-------|-----|-----------|
| Claude Context (Zilliz) | 5,900 | No (cloud) | Single codebase | Yes | No |
| mgrep (Mixedbread) | 4,000 | Hybrid | Files + web | Yes | No |
| Semantra | 2,700 | Yes | Specified files | No | No |
| grepai | 1,600 | Yes (Ollama) | Single codebase | Yes | No |
| CocoIndex Code | 1,400 | Yes | Single codebase | Yes | No |
| Probe | 542 | Yes | Single codebase | Yes | No |
| SocratiCode | Small | Yes (Docker) | Cross-project | Yes | No |
| ogrep | New | Yes | Single codebase | No | No |

**Key finding:** Every tool in this category searches inside a codebase. None answer "where is that repo" or search across your machine. They are IDE-adjacent productivity tools, not machine-level search.

**Relevance to Machine Memory:** Not competitive. Machine Memory searches across repos (finding which repo matches a query), while these tools search within a single repo. Could be complementary -- Machine Memory finds the repo, then a code search tool searches inside it.

---

### Category 4: Git Repo Discovery (finds repos on your machine)

| Tool | Stars | Search | Semantic | Metadata |
|------|-------|--------|----------|----------|
| gfold | 388 | No (dashboard only) | No | Branch, remote, status |
| multi-git-status | 528 | No (status only) | No | Dirty/clean status |
| git-global | Small | Fuzzy name | No | Basic |
| git-find | 8 | No | No | Template output (archived) |

**Key finding:** This is the weakest category. No tool lets you search repos by meaning, topic, README content, or GitHub remote. gfold is the best (Rust, fast, shows all repos) but it is a status dashboard, not a search engine.

**Relevance to Machine Memory:** This is Machine Memory's strongest differentiator. Nobody does this well. The query "where is gitonsteroid" or "find the repo about quantization" has zero good answers today.

---

### Category 5: Image Search and Photo Management

| Tool | Stars | CLIP Semantic | OCR | EXIF | Face | Local |
|------|-------|--------------|-----|------|------|-------|
| Immich | 97,900 | Yes | No | Yes | Yes | Self-hosted |
| Umi-OCR | 43,300 | No | Best standalone | No | No | Yes |
| PhotoPrism | 39,500 | Yes | No | Yes | Yes | Self-hosted |
| LibrePhotos | 7,900 | Yes | No | Yes | Yes | Self-hosted |
| clip-retrieval | 2,750 | Yes | No | No | No | Yes |
| digiKam | 747* | No | No | Yes | Yes | Yes |
| ImageIndexer | 354 | VLM-based | No | Yes | No | Yes |
| CLIPPyX | 278 | Yes | Yes | No | No | Yes |
| Facet | 81 | Yes | No | Yes | Yes | Yes |

*digiKam stars from GitHub mirror; actual user base is much larger (KDE project).

**Key finding:** Photo management is well-served by Immich (98K stars, dominant) and PhotoPrism. But these are photo library managers (Docker, server, web UI), not desktop search tools. For lightweight "find an image by content on my local machine," CLIPPyX is the best fit but is a standalone tool, not part of a broader machine search.

**Relevance to Machine Memory:** Machine Memory does not need to compete with Immich as a photo manager. It needs to answer "find the image I took in Colorado" by combining EXIF location + CLIP embeddings + OCR, as part of a broader machine search -- not as a dedicated photo app. The building blocks exist (CLIP, Tesseract/PaddleOCR, ExifTool) but nobody assembles them into a general-purpose machine search tool.

---

### Category 6: Personal Memory / "Second Brain" Products

| Tool | Type | Local | Platforms | What it indexes |
|------|------|-------|-----------|-----------------|
| Pieces for Developers | Commercial | Yes | Mac/Win/Linux | Code, notes, links, conversations |
| Fenn | Commercial | Yes | Mac only | Files, PDFs, images, audio/video |
| Mem.ai | Commercial | No (cloud) | Web/iOS/Mac | Notes |
| Heyday | Commercial | No (cloud) | Chrome | Browser history |
| PocketLLM (ThirdAI) | Free | Yes | Mac/Win | Docs, email, bookmarks |
| Elephas | Commercial | Hybrid | Mac/iOS | Docs, code, webpages |
| TraceMind | Freemium | Yes | Chrome | Browser history |
| Basic Memory | OSS | Yes | MCP | LLM conversation knowledge |
| Perplexity Personal Computer | Commercial | Hybrid | Mac mini | Files, email, Slack, GitHub |

**Key finding:** Fragmented. Each tool picks one narrow slice. Pieces is developer-specific. Fenn is Mac-only file search. Heyday/TraceMind are browser-only. Perplexity's offering costs $200/month and requires cloud. Nobody offers a unified, cross-platform, local-first machine memory.

---

### Category 7: The Closest Direct Competitors

These are the projects most similar to Machine Memory's vision:

#### Rememex (60 stars)
- GitHub: https://github.com/illegal-instruction-co/rememex
- **Stack:** Rust (Tauri 2) + React, LanceDB, Multilingual-E5-Base, JINA Reranker, UWP OCR
- **What it does:** Indexes 120+ file types. Semantic search, OCR, EXIF with reverse geocoding, temporal EXIF parsing ("summer morning" finds July 8am photos), git log integration, MCP server, hybrid search with reranking
- **Weaknesses:** Windows 10+ only, GUI-only (no CLI), very new (Feb 2026), tiny community
- **Gap vs Machine Memory:** No CLI, no cross-platform, no full git repo scanning (only git log), Windows-only OCR

#### Second Brain (454 stars)
- GitHub: https://github.com/henrydaum/second-brain
- **Stack:** Python, SQLite FTS5, BGE-M3 (text), CLIP ViT-L-14 (images), Windows OCR, Whisper
- **What it does:** Watches directories, indexes text/images/audio/video/archives, hybrid BM25+vector search, chat interface
- **Weaknesses:** Windows-focused OCR, no git awareness, no EXIF/temporal search, no MCP, no CLI (GUI only)
- **Gap vs Machine Memory:** No git repos, no EXIF, no MCP, no time-based queries, Windows-centric

#### QMD (21,800 stars)
- GitHub: https://github.com/tobi/qmd (by Shopify CEO Tobi Lutke)
- **Stack:** TypeScript/Bun, node-llama-cpp, GGUF models, BM25+vector+LLM reranking
- **What it does:** CLI-first local semantic search for Markdown docs and knowledge bases. Hybrid search pipeline is state-of-the-art for local use
- **Weaknesses:** Markdown/text only, no images, no OCR, no git, no filesystem crawling
- **Gap vs Machine Memory:** Docs-only scope, no machine-wide ambition, no images, no repos

#### txtai (12,400 stars)
- GitHub: https://github.com/neuml/txtai
- **Stack:** Python, custom embeddings DB, Sentence Transformers, CLIP, BLIP, FastAPI
- **What it does:** Framework for semantic search across text, images, audio, video
- **Weaknesses:** Framework, not a product. No filesystem crawling, no CLI, no git awareness. You build on top of it.
- **Gap vs Machine Memory:** Not a product. Could be a dependency rather than a competitor.

---

## The Gap Analysis

### What Machine Memory does that NOBODY does today

**1. Cross-source machine-wide semantic search with developer awareness.**
No tool indexes git repos + files + images + PDFs + screenshots + downloads together in one searchable index. Every competitor picks one slice.

**2. The "where is that repo" query.**
Literally zero tools answer this well. You cannot search local repos by meaning, topic, README content, or GitHub remote anywhere today.

**3. Git repo metadata as a first-class citizen.**
Rememex has basic git log integration. Context-Lens indexes GitHub repos via API. Nobody scans local git repos for remotes, branches, README content, package manifests, and makes them semantically searchable.

**4. Time + location + content search together.**
Only Rememex does temporal EXIF parsing, and only on Windows. The query "find the image I took in Colorado" requires combining EXIF GPS + semantic content + time -- nobody does this cross-platform.

**5. CLI-first + MCP interface for AI agents.**
QMD proves CLI-first local search works. But QMD is docs-only. Machine Memory's plan to serve both humans (CLI) and AI agents (MCP) with machine-wide context is novel.

### What Machine Memory is up against

**6. Screenpipe is the gravity well.** 18K stars, $2.8M raised, MIT license, cross-platform. If Screenpipe adds filesystem indexing alongside screen recording, it becomes the closest competitor. Watch this project closely.

**7. QMD validates the approach but not the scope.** CLI-first, local-first, hybrid search, by a famous founder. If Tobi expands QMD beyond docs into repos/files, it could absorb Machine Memory's market.

**8. Apple Intelligence is the strongest incumbent for Mac users.** Semantic search in Spotlight, on-device, fast. But locked to Apple ecosystem, no third-party access to the semantic index, no Linux/Windows, no customization.

**9. The "chat with docs" tools could expand down.** Khoj (34K stars), Anything-LLM (58K stars), or RAGFlow (78K stars) could add filesystem crawling. But their architectures are upload-based, not crawl-based -- this is a hard pivot.

---

## Competitive Matrix: Machine Memory vs Closest Alternatives

| Capability | Machine Memory (planned) | Rememex | Second Brain | QMD | Screenpipe | Khoj |
|------------|------------------------|---------|--------------|-----|------------|------|
| Crawls filesystem | Yes | Yes | Yes | Dir-based | No (screen) | No |
| Git repo scanning | Yes (full) | Git log only | No | No | No | No |
| OCR images/screenshots | Yes | Yes (Win) | Yes (Win) | No | Yes | Via LLM |
| EXIF/location search | Yes | Yes (Win) | No | No | No | No |
| Semantic/embedding search | Yes | Yes | Yes | Yes | Text search | Yes |
| Time-based queries | Yes | Yes | No | No | Yes | No |
| PDF text extraction | Yes | Yes | No | No | No | Yes |
| CLI interface | Yes | No (GUI) | No (GUI) | Yes | No | No |
| MCP for AI agents | Yes | Yes | No | No | Yes | No |
| Cross-platform | Yes | Windows only | Windows-focused | Yes | Yes | Yes |
| Hybrid search (BM25+vector) | Yes | Yes | Yes | Yes | No | Yes |
| Result explanation (why matched) | Yes | Unknown | No | No | No | No |
| Local-first, no cloud | Yes | Yes | Yes | Yes | Yes | Self-host |
| Open source | Planned | Yes | Yes | MIT | MIT | AGPL |

---

## Tech Stack Intelligence

### What the winners are built with

**Languages:**
- Rust: Screenpipe, Rememex (Tauri), gfold, Probe
- TypeScript: QMD, mgrep, Claude Context, CocoIndex
- Python: Khoj, RAGFlow, Second Brain, txtai, most ML-heavy tools

**Embedding models (local):**
- Sentence Transformers / BGE-M3 (text): most popular
- CLIP ViT-L-14 (images): dominant for image search
- Multilingual-E5-Base: Rememex
- nomic-embed-text via Ollama: growing

**Vector storage:**
- SQLite + custom: QMD, Second Brain, Screenpipe
- LanceDB: Rememex, Anything-LLM
- ChromaDB: many smaller projects
- FAISS: clip-retrieval, research tools
- Qdrant: SocratiCode (via Docker)

**OCR:**
- Tesseract: Recoll, NormCap (cross-platform, established)
- PaddleOCR: Umi-OCR (43K stars, fast, 100+ languages)
- Windows UWP OCR: Rememex, Second Brain (Windows-only)
- Apple Vision: Screenpipe on macOS
- Custom/DeepDoc: RAGFlow (best quality, heaviest)

**Search:**
- BM25 + vector hybrid with RRF: QMD, Onyx, Second Brain (emerging standard)
- LLM reranking on top: QMD (state of the art for local)

### Recommended stack direction for Machine Memory

Based on what works in the wild:
- **Language:** Rust or Python (Rust for performance + CLI, Python for ML ecosystem)
- **Embeddings:** BGE-M3 (text) + CLIP (images), local via ONNX or Ollama
- **Storage:** SQLite (metadata + FTS5) + LanceDB or FAISS (vectors)
- **OCR:** PaddleOCR (cross-platform, fast) or Tesseract (lighter, more portable)
- **Search:** BM25 + vector hybrid with reciprocal rank fusion
- **Git:** git2 (Rust) or GitPython

---

## Strategic Implications

### The window is open

1. Rewind's death (Dec 2025) left a vacuum. Users are looking for alternatives.
2. Microsoft Recall's failure (privacy backlash, hardware lock-in) proves the market wants local-first.
3. No cross-platform tool answers "where is that file/repo/image" today.
4. The building blocks are mature (local embeddings, CLIP, OCR, vector DBs) -- this is an assembly problem, not a research problem.

### The risks

1. Screenpipe could expand into filesystem indexing.
2. QMD could expand beyond docs.
3. Apple could open their semantic index to third parties (unlikely but possible).
4. A well-funded startup could assemble the same pieces faster.

### The strongest wedge

"Find the repo/file/thing I was working on" -- developer-focused, CLI-first, cross-platform, local-only. This is the query nobody answers today, the user segment most willing to adopt CLI tools, and the starting point that expands naturally into broader machine memory.

---

## All Projects Referenced

### Screen Recording Memory
1. [Screenpipe](https://github.com/screenpipe/screenpipe) -- 18,200 stars, MIT
2. [OpenRecall](https://github.com/openrecall/openrecall) -- 2,800 stars, AGPL
3. [Windrecorder](https://github.com/yuka-friends/Windrecorder) -- 3,800 stars, GPL
4. [LiveRecall](https://github.com/VedankPurohit/LiveRecall) -- 161 stars, MIT
5. Microsoft Recall -- proprietary, Windows 11
6. Rewind AI / Limitless -- dead, acquired by Meta
7. Littlebird -- commercial, $11M raised

### Document Q&A
8. [RAGFlow](https://github.com/infiniflow/ragflow) -- 78,200 stars
9. [Anything-LLM](https://github.com/Mintplex-Labs/anything-llm) -- 58,400 stars
10. [PrivateGPT](https://github.com/zylon-ai/private-gpt) -- 57,200 stars
11. [Khoj](https://github.com/khoj-ai/khoj) -- 34,100 stars, AGPL
12. [Onyx/Danswer](https://github.com/onyx-dot-app/onyx) -- 27,200 stars, MIT
13. [LocalGPT](https://github.com/PromtEngineer/localGPT) -- 22,200 stars

### Semantic Code Search
14. [Claude Context](https://github.com/zilliztech/claude-context) -- 5,900 stars
15. [mgrep](https://github.com/mixedbread-ai/mgrep) -- 4,000 stars
16. [grepai](https://github.com/yoanbernabeu/grepai) -- 1,600 stars
17. [CocoIndex Code](https://github.com/cocoindex-io/cocoindex-code) -- 1,400 stars
18. [Probe](https://github.com/probelabs/probe) -- 542 stars
19. [SocratiCode](https://github.com/giancarloerra/socraticode) -- small
20. [ogrep](https://ogrep.be/) -- new
21. [Sturdy semantic-code-search](https://github.com/sturdy-dev/semantic-code-search) -- 396 stars, unmaintained

### Git Repo Discovery
22. [gfold](https://github.com/nickgerace/gfold) -- 388 stars, Rust
23. [multi-git-status](https://github.com/fboender/multi-git-status) -- 528 stars
24. [git-global](https://github.com/peap/git-global) -- small, Rust
25. [git-find](https://github.com/davidB/git-find) -- archived
26. [git-scan](https://github.com/totten/git-scan) -- older

### Image / Photo Search
27. [Immich](https://github.com/immich-app/immich) -- 97,900 stars
28. [Umi-OCR](https://github.com/hiroi-sora/Umi-OCR) -- 43,300 stars
29. [PhotoPrism](https://github.com/photoprism/photoprism) -- 39,500 stars
30. [LibrePhotos](https://github.com/LibrePhotos/librephotos) -- 7,900 stars
31. [clip-retrieval](https://github.com/rom1504/clip-retrieval) -- 2,750 stars
32. [CLIPPyX](https://github.com/0ssamaak0/CLIPPyX) -- 278 stars
33. [ImageIndexer](https://github.com/jabberjabberjabber/ImageIndexer) -- 354 stars
34. [Facet](https://github.com/ncoevoet/facet) -- 81 stars
35. [digiKam](https://www.digikam.org/) -- KDE project
36. [NormCap](https://github.com/dynobo/normcap) -- 2,577 stars
37. ExifTool -- gold standard for metadata

### Direct Competitors
38. [Rememex](https://github.com/illegal-instruction-co/rememex) -- 60 stars, Windows-only
39. [Second Brain](https://github.com/henrydaum/second-brain) -- 454 stars
40. [QMD](https://github.com/tobi/qmd) -- 21,800 stars, docs-only
41. [txtai](https://github.com/neuml/txtai) -- 12,400 stars, framework
42. [Semantra](https://github.com/freedmand/semantra) -- 2,700 stars, dormant
43. [Open Semantic Search](https://github.com/opensemanticsearch/open-semantic-search) -- 1,170 stars
44. [AIFS](https://github.com/OpenInterpreter/aifs) -- 451 stars, dormant
45. [Context-Lens](https://github.com/cornelcroi/context-lens) -- 20 stars

### Personal Memory Products
46. [Fenn](https://www.usefenn.com/) -- commercial, Mac-only
47. [Vector](https://vector.ethanlipnik.com/) -- commercial, Mac-only
48. [Pieces for Developers](https://pieces.app) -- commercial, cross-platform
49. [Mem.ai](https://get.mem.ai) -- commercial, cloud
50. [Heyday](https://heyday.xyz) -- commercial, Chrome
51. [TraceMind](https://tracemind.app) -- freemium, Chrome
52. [Basic Memory](https://github.com/basicmachines-co/basic-memory) -- OSS, MCP
53. [PocketLLM](https://thirdai.com) -- free, local
54. [Elephas](https://elephas.app) -- commercial, Mac/iOS
55. Perplexity Personal Computer -- $200/month, waitlist

### Platform Native
56. Apple Spotlight / Apple Intelligence -- macOS/iOS
57. Windows Search / Semantic Indexing -- Win 11, NPU required
58. [Recoll](https://www.recoll.org/) -- Linux, keyword-based
59. [DocFetcher](https://docfetcher.sourceforge.io/) -- cross-platform, keyword-based
60. [Everything](https://www.voidtools.com/) -- Windows, filename-only

### Desktop/MCP Infrastructure
61. [Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP)
62. Anthropic Filesystem MCP Server
