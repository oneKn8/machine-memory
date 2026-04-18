# Problems And Users

## Primary Problem

Users often know a thing exists but cannot recover it efficiently.

Examples:

- forgotten file path
- unknown repo location
- vague memory of a screenshot
- downloaded movie with unclear filename
- image associated with a person or place, not a path
- document tied to a project idea, not a folder

## Secondary Problems

- "What was I doing?"
- "What is related to this?"
- "When did I first think about this?"
- "How do I get back into flow?"

## Primary Users

### Developers

Pain:

- too many repos
- duplicate clones
- forgotten branches
- lost commands
- scattered docs
- screenshots and notes detached from projects

### Power Users

Pain:

- lots of files across arbitrary directories
- poor organization
- weak recall over time
- trouble finding downloads, media, and docs

### Creators / Researchers

Pain:

- image and document sprawl
- references scattered across folders and apps
- hard to recover context for a workstream

### AI Agents Running On The User's Machine

Pain (measured in wasted tokens and wrong answers):

- no retrieval layer that is already right, so they fall back to blind `grep`/`glob`/file-read loops
- context windows overflow with irrelevant file bodies dumped whole
- no provenance, so answers cannot cite evidence
- no persistent memory of what they have already looked at this session

This is a user too, not only a downstream integration. Phases 1–4 ship the substrate that phase 5 exposes to agents through a clean retrieval interface. Every design choice that makes human recall better also makes agent grounding better.

## Strongest Early User

Developers and technical power users on Linux.

Why:

- high pain
- tolerant of rough edges
- easier to ship CLI-first
- easier to index git, terminals, repos, docs, and local files

## Jobs To Be Done

- Find the thing I vaguely remember.
- Show me what I was working on.
- Bring me back to the project.
- Connect files, repos, and notes that belong together.
- Give my AI tools real machine context.
