# Gotchas and Honest Risks

**Dated:** 2026-04-25.

**Status:** Living document. Append entries as new traps are discovered. Existing entries should be updated (not deleted) when their resolution changes.

**Purpose.** This doc is the project's accumulated honesty. Every soft assumption, every adoption risk, every "easy to build, hard to make useful" trap, and every place where the written plan and reality might diverge. It exists so that future contributors (including future-Shifat and any AI working on this) do not re-discover problems that have already been seen, and do not repeat them.

It is not a TODO list. The references-index spec ([`docs/26-references-index.md`](./26-references-index.md)) is the right place for concrete additions. This doc captures *traps* — things that look fine until they don't.

**Inputs this doc synthesizes:**

- [`docs/01-product-thesis.md`](./01-product-thesis.md) — north star
- [`docs/13-decision-log.md`](./13-decision-log.md) — D-019 phase collapse
- [`docs/15-current-state.md`](./15-current-state.md) — what's actually shipped
- [`docs/22-phase-2-research.md`](./22-phase-2-research.md) — Phase 2 design
- [`docs/23-product-v2-architecture.md`](./23-product-v2-architecture.md) — canonical architecture
- Conversation 2026-04-25 with audit-style review of the full phase arc

---

## 1. How to read this doc

Each gotcha is structured:

- **Trap.** The mistake or assumption.
- **Why it's hard to see.** What makes it invisible at first glance.
- **Detect.** Concrete signal that you're in it.
- **Mitigation.** What to do.
- **Severity.** Low / Medium / High based on how badly it sinks the project if ignored.

Severity is about *project survival*, not engineering effort. A High-severity gotcha may be cheap to fix; it's High because ignoring it makes the project pointless.

---

## 2. Engineering gotchas

### G-1. Agents will not auto-adopt your MCP server

**Trap.** Shipping `mmd` with an embedded MCP server and assuming Claude Code, Cursor, or any other agent will reach for `mm_find` instead of their built-in `Grep` / `Glob` / file-read tools.

**Why it's hard to see.** "We expose it over MCP" feels like adoption. It is not. MCP exposure is a *connection*. Adoption is the agent *choosing* your tool over a built-in one. Built-in tools win by default because they are zero-config, zero-failure-mode, and the agent has been trained on them.

**Detect.** After Phase 1 ships and you wire `machine-memory` into Claude Code's `~/.claude/settings.json`, watch the next 10 sessions. If you see Claude Code calling `Grep` or `Bash(grep ...)` for queries that `mm_find` would have answered, the adoption gap is real.

**Mitigation.**

1. The MCP tool description is the LLM's only signal for *when to use it*. Make it explicit: *"Use this BEFORE running grep/find/glob on the user's machine. Returns ranked file results with provenance. Faster and cheaper than blind search."* Generic descriptions lose to default tools.
2. Build a side-by-side benchmark page in this repo (`docs/benchmarks/`) showing real query pairs: *"agent ran blind grep, used N tokens, found Y. mm_find returned correct answer in M tokens."* Use the actual numbers as the marketing for the tool description.
3. After Phase 1, audit *your own* Claude Code session telemetry to see if you reach for it. If you don't, no one will.

**Severity:** High. This is the failure mode where the entire substrate framing collapses. If agents don't use it, the "two consumers, one substrate" thesis dies, and the project becomes a personal local search tool with extra steps.

---

### G-2. The wiki compiler loop (Phase 3) is the easiest layer to build and the hardest to make trustworthy

**Trap.** Building an LLM-driven compiler that continuously regenerates entity pages and project summaries from your local files. It will produce plausible, well-structured markdown that is occasionally and silently wrong.

**Why it's hard to see.** The output looks right. LLMs are exceptionally good at sounding correct. A wiki page that says *"the `vectorvault` repo is a Python C++ binding for a vector database"* will read fine even when it's wrong about the language, the binding direction, or the database type. You will not catch it until you act on it.

**Detect.** When you find yourself trusting a `mm_get_wiki <entity>` result without checking the source. When agents start citing the wiki instead of the underlying file.

**Mitigation.**

1. Every wiki page must include a "sourced from" provenance block — the exact file paths and line ranges the compiler read. No exceptions. If you can't link the claim to a source, the claim doesn't ship.
2. A wiki page that disagrees with its sources should fail loudly (the compiler emits a `wiki_drift` event) rather than write the page anyway.
3. Defer Phase 3 entirely until Phase 1, 1.5, and 2 are validated and you have a corpus of agent queries that *prove* the wiki layer would help. If lexical + activity + entity graph already answer 90% of agent queries, you do not need a wiki.
4. When Phase 3 does ship, ship it with `mm_get_wiki` returning *both* the wiki page and a "verify from sources" section. Force the consumer to confront provenance.

**Severity:** High. Untrusted wiki content can poison agent reasoning. An agent that cites a wrong wiki page about your codebase can break code based on a hallucinated assumption. This is more dangerous than no wiki at all.

---

### G-3. Phase 4 `mm_chat` duplicates Claude Code

**Trap.** Building a conversational REPL on top of `mm_chat` that lets the user have a "chat with my machine" experience.

**Why it's hard to see.** It feels like the natural endpoint of the substrate. The substrate has all this knowledge — *of course* you should be able to chat with it. It is also fun to build.

**Detect.** Ask: *"in what scenario would I open `mm chat` instead of typing `claude` in the same terminal?"* If the only honest answer is *"when I want to demo the project,"* it's redundant.

**Mitigation.**

1. Don't build it as a competing chat interface. Build it as a *thin* MCP tool that any chat surface (Claude Code, Cursor, your own terminal) can call. Let other tools provide the chat UI.
2. If the conversational layer is Phase 4, ship the MCP tool first. Add the CLI REPL only if multiple people ask for it. They probably won't.
3. Genuinely consider cutting Phase 4 entirely. The thesis (`docs/01`) does not require a chat surface — it requires a substrate. The CLI is `mm`, the agent surface is MCP. Adding `mm chat` is scope creep dressed as feature.

**Severity:** Medium. Building it costs time. Not building it costs nothing. The risk is that it ships and nobody uses it, which is wasted engineering — not catastrophic, but the kind of mistake that happens when "feels like the right next thing" overrides "is anyone asking for this."

---

### G-4. Semantic retrieval is in design limbo

**Trap.** D-011 deferred semantic search. `22§6` says Phase 2.5. `23` doesn't mention it. When the time comes to add it, you will not know which doc is authoritative.

**Why it's hard to see.** Each doc is internally consistent. The drift is across docs. You only notice when you go to implement it and the three docs say three things.

**Detect.** When someone asks "where does `sqlite-vec` integration live in the plan?" and the answer requires reading three docs and reconciling them.

**Mitigation.** When Phase 2 ships and you have a corpus of FTS-miss queries, write a single decision-log entry resolving the question: which phase, which library, what shape. Until then, do not pre-build it. Premature semantic retrieval was the failure mode of three other tools mentioned in `docs/14-competitive-landscape.md`.

**Severity:** Medium. Limbo is fine if it stays limbo. Becomes High the moment someone spends effort building it on a stale plan.

---

### G-5. Phase 1.5 (references-index) was added without updating the canonical docs

**Trap.** The references-index spec at [`docs/26-references-index.md`](./26-references-index.md) was written 2026-04-25 in response to three same-shape reorg breaks on the same day. As of writing this gotcha, neither [`docs/06-roadmap-phases.md`](./06-roadmap-phases.md) nor [`docs/13-decision-log.md`](./13-decision-log.md) nor [`docs/23-product-v2-architecture.md`](./23-product-v2-architecture.md) has been updated to reflect that Phase 1.5 exists.

**Why it's hard to see.** The spec doc is fine in isolation. It only becomes a gotcha when someone reads the roadmap, doesn't see Phase 1.5, and either (a) duplicates the work, (b) ignores the spec because it looks unauthorized, or (c) ships Phase 1 without slotting in the references-index parallel work.

**Detect.** Any time someone asks "what are the phases?" and the answer omits 1.5.

**Mitigation.**

1. Add a D-020 entry to `docs/13-decision-log.md` recording why Phase 1.5 was inserted (the 2026-04-25 reorg-break trio).
2. Update `docs/06-roadmap-phases.md` to slot Phase 1.5 in.
3. Update `docs/23-product-v2-architecture.md` §3 (System Shape) to note that the daemon's index tier list now includes a refs tier.
4. Cross-link `docs/26` from each of the above so future readers can find the spec from any entry point.

**Severity:** High. Orphan specs rot. If this isn't fixed within the next decision-log update cycle, Phase 1.5 will quietly stop being part of the plan.

---

### G-6. Phases 3, 4, 5 are designed but not specced

**Trap.** Phase 1 has a build-order doc (17), a completion checklist (18), and validation reports (19, 24, 25). Phase 2 has the research doc (22) with the schema locked. Phases 3–5 each get one paragraph in `docs/23-product-v2-architecture.md`. The implementation specificity drops off a cliff after Phase 2.

**Why it's hard to see.** A `docs/` folder with 27 numbered files looks comprehensive. The thinning is invisible until you try to start Phase 3.

**Detect.** When someone asks "what's the build order for Phase 3?" and the answer is "we'll figure it out when we get there."

**Mitigation.** Don't spec Phases 3–5 prematurely — premature specs rot worse than missing specs. Do, however, write the spec the moment Phase 2 enters its completion checklist. Phase 3 should not begin without a build-order doc parallel to `docs/17`.

**Severity:** Low (now), Medium (the moment Phase 2 ships). The risk is starting Phase 3 without a plan and improvising.

---

## 3. Adoption gotchas

### A-1. You are not your user

**Trap.** Building a memory daemon for your own machine on the assumption that other developers want the same thing.

**Why it's hard to see.** Your own pain is vivid and concrete. Other developers' pain is hypothetical. You will optimize for the pain you can feel, which means you will optimize for one user.

**Detect.** Open `docs/02-problems-and-users.md`. Count the named non-Shifat users. If the answer is zero, you have an adoption gotcha.

**Mitigation.**

1. After Phase 1 ships, install it on 3–5 other developers' Linux machines (start with the closest people who would tolerate friction). Watch them use it. Watch what they don't use. Their failure modes are your real backlog.
2. Resist the urge to build features only Shifat would want. The references-index (Phase 1.5) is a good example of dual-use: it solves Shifat's problem AND any agent-author's problem on any reorg-prone machine.
3. The thesis says "for the human who owns the machine" (singular, unqualified). Either commit to single-user-Shifat as the explicit scope (and stop comparing to GraphRAG, Mem0, etc. in `docs/14`), or commit to broader adoption and act on it.

**Severity:** High. The substrate framing breaks if there is one user. Two consumers (you + agents) does not equal two users. Without external humans, the agent half is also fragile, because agent authors won't configure your MCP server for one person's machine.

---

### A-2. No metric for "agents are using this"

**Trap.** "Agents first, humans second" is the project's identity (per `docs/23§1`), but no validation doc defines what agent adoption looks like in numbers.

**Why it's hard to see.** Validation reports for Phase 0 (19, 24, 25) measure retrieval correctness and extraction coverage. They do not measure consumer behavior. You can ship Phase 1 perfectly and have no way to know if agents picked it up.

**Detect.** After Phase 1 ships, ask "how many `mm_find` calls came from Claude Code last week?" If the answer requires bespoke log-grepping, the metric isn't designed in.

**Mitigation.** Add an "agent adoption telemetry" requirement to `docs/18-phase-1-completion-checklist.md`. At minimum: per-MCP-tool call counts, broken down by client name (from MCP `clientInfo` field). The daemon already has a SQLite database — adding a `tool_calls` table is trivial. Without this, the project flies blind on its own thesis.

**Severity:** High. You cannot improve what you do not measure. Without this, "agent adoption" stays a vibe instead of a fact.

---

### A-3. The competitive comparisons may be aspirational

**Trap.** `docs/14-competitive-landscape.md` and `docs/23` reference Karpathy's LLM Wiki, Microsoft GraphRAG, Mem0, Anthropic's Contextual Retrieval. The framing positions machine-memory in this category.

**Why it's hard to see.** Comparing yourself to influential prior art is good thinking. It also creates an implicit promise that you'll eventually be in that league.

**Detect.** When you describe machine-memory to anyone, do you say "it's like GraphRAG but local" or "it's a local search daemon"? The first is aspirational. The second is honest.

**Mitigation.** For the next 6 months, describe machine-memory as the second thing. The first thing is what it might become if Phases 3 and 4 ship and prove their value. Don't claim the position before you've earned it. The competitive landscape doc is fine; just don't let its framing sneak into the thesis or the README until reality matches.

**Severity:** Low. This is a marketing risk, not an engineering one. Becomes Medium if it shapes Phase 3 design ("must rival GraphRAG") instead of "must answer agent queries reliably."

---

## 4. Plan-coherence gotchas

### P-1. The mental "Phase 7" doesn't exist in any doc

**Trap.** Shifat refers to "Phase 7" in conversation. The docs go up to Phase 5 (v2 framing) plus Phase 6+ (deferred system work). There is no Phase 7 written down.

**Why it's hard to see.** Mental models drift. A vision discussed once and never written down feels real and shared. It isn't.

**Detect.** Any time the project's scope is described in conversation but not findable in `docs/`.

**Mitigation.** Either (a) write down what the mental Phase 7 actually is (could be multi-machine sync, hosted variant, knowledge-graph reasoning beyond the wiki, social/shared memory across people, something else), and decide whether to add it to the roadmap, or (b) explicitly drop the term "Phase 7" until it has a doc behind it.

**Severity:** Medium. A vision that lives only in one head is fragile and confusing to anyone who joins the project. It also implies a commitment that nobody has actually made.

---

### P-2. The phase-collapse pivot (D-019) left some orphaned content

**Trap.** `docs/06-roadmap-phases.md` was written in the original 6-phase framing. `docs/23` collapsed those into 5 layers. Doc 06 has not been retroactively rewritten to match 23. New readers find both docs and have to reconcile them.

**Why it's hard to see.** Both docs are internally consistent. The mismatch is structural.

**Detect.** When someone reads `06`, then reads `23`, then asks "wait, are there 6 phases or 5?"

**Mitigation.** Either rewrite `docs/06` to match the v2 layer framing (preserving original numbering as historical context in an appendix), or add a prominent "SUPERSEDED — see docs/23" banner at the top of `docs/06`. The current state assumes the reader will discover D-019 in the decision log on their own. Most won't.

**Severity:** Medium. Coherent documentation is the difference between a project a future contributor can pick up and one they bounce off.

---

### P-3. Decision log is good, but D-019 is the only "structural" decision recorded

**Trap.** D-001 through D-018 are mostly tactical decisions (pragma settings, fuzzy matching thresholds). D-019 is the first big "what is this product" decision recorded. Future structural decisions (semantic retrieval scope, agent telemetry, drop or keep Phase 4, etc.) need the same treatment.

**Why it's hard to see.** The log looks healthy. It is, for tactical decisions. The risk is that the next big structural decision gets made in conversation and never recorded.

**Detect.** Any time a decision is made that changes the product shape (not just a parameter), grep for it in `docs/13`. If it's not there, write it before continuing.

**Mitigation.** When this `docs/27-gotchas-and-honest-risks.md` file recommends a project-shape change (e.g. cutting Phase 4, deferring Phase 3 indefinitely, switching to Linux-only commitment), the resulting decision should land as a D-NNN entry in the log. Don't let strategic decisions live only in conversation.

**Severity:** Medium. Becomes High if Phases 3, 4, or 5 get cut without the decision being recorded — future contributors will be confused.

---

## 5. What to do when you encounter a gotcha

1. **Recognize the symptom.** The "Detect" line in each entry is the early-warning signal.
2. **Read the entry, follow the mitigation.** Don't reinvent the workaround.
3. **Update the entry if reality has changed.** Severity may drop after mitigation; add a "Resolution" subsection. Don't delete entries — the trap is durable even after the project escapes it.
4. **Add new entries when you find new traps.** Use the same structure. Number them by category (G-N for engineering, A-N for adoption, P-N for plan).

---

## 6. What this doc is not

- It is not a list of bugs. Those go in GitHub issues or a project tracker.
- It is not a list of features. Those go in `docs/03-idea-backlog.md`.
- It is not a list of TODOs for the current phase. Those go in `docs/17-phase-1-build-order.md` (or the equivalent for the active phase).
- It is not a competitive analysis. That is `docs/14`.
- It is not philosophical. Each entry should be actionable.

The entries here are *durable structural risks* — things that don't get fixed by writing one more line of code, things that the project must navigate around carefully or be sunk by.

---

## 7. Status reminder

This doc was written 2026-04-25 after a full audit of the phase plan against `docs/01, 06, 13, 15, 22, 23`. The audit conclusions:

- **Plan is structurally sound** with three cleanups owed (G-5, P-1, P-2 above).
- **Phase 1 + 1.5 are the two layers most likely to be useful.**
- **Phase 3 + 4 are the two layers most at risk of being engineered for their own sake.**
- **Phase 5 is premature** until external Linux adoption demands it.
- **Biggest risk is adoption (A-1, A-2), not engineering.**

Future contributors: if this status section is more than 60 days old, re-audit and update it. The traps may have moved.
