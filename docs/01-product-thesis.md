# Product Thesis

## North Star

Make a computer remember everything, and make that memory usable — instantly, privately, and efficiently — for both the human who owns the machine and for any AI the human works with.

The product has two consumers from day one:

- the human, asking "where is that thing I half-remember?"
- the AI agent, which today wastes tokens on blind `grep`/`glob`/file-read loops because it has no retrieval layer that is already right.

Machine Memory is the system that decides what context gets seen before any thinking happens. For the human, that is a search answer. For an AI, that is the small, grounded set of files, snippets, and metadata it should reason over instead of the whole machine.

## Core Thesis

Computers are good at storing information and bad at helping people recover it by memory.

Most retrieval today still depends on:

- exact filenames
- folder location
- app-specific search
- user discipline

That fails when the user only remembers fragments such as:

- what the thing was about
- when they saw it
- who it involved
- where they were
- what project it belonged to

Machine Memory exists to let users — and the AI tools they use — search a machine by meaning, memory, and context.

## Product Promise

The user can ask:

- "Where the hell is that file?"

And the system should respond with a grounded, useful answer.

An AI agent, running on the same machine, can ask the same system for the smallest set of files, snippets, and metadata that actually matter to its current task, and receive a grounded answer it can trust instead of a folder to crawl.

## Why This Is Valuable

The machine already contains:

- work
- ideas
- photos
- repos
- downloads
- documents
- screenshots
- traces of intent

The missing layer is machine-native recall.

## The Product We Are Actually Building

Not:

- a generic AI assistant
- a note-taking clone
- a better Spotlight
- a toy semantic search wrapper

But:

- a private answer engine for a machine, serving both the human and the machine's AI tools

The search layer is what lets the product work for humans today. The same retrieval layer, exposed through a clean interface, is what lets the product ground AI agents later. Both are the same product, delivered in phases — not a pivot.

## Design Principles

- Local-first
- Privacy-first
- Fast
- Grounded in real files and metadata
- Useful before it is magical
- Search first, agents later
- Thin observability layer, rich user-space intelligence

## Expansion Path

The product can grow in layers:

1. find things
2. recover work
3. explain relationships
4. take actions
5. remember over time
6. become a shared memory substrate for AI agents
