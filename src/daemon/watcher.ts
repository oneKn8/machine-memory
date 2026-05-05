import type { Stats } from 'node:fs'
import chokidar, { type FSWatcher } from 'chokidar'
import picomatch from 'picomatch'
import { DEFAULT_EXCLUDE_GLOBS } from '../config/defaults.js'

// Slice 3 Task 3 — chokidar watcher wrapper.
//
// Pipeline: chokidar -> WatcherEvent -> caller's onEvent. The caller
// (Tasks 4-5) feeds events into the per-path debouncer, which feeds
// the worker pool, which feeds the writer queue, which writes to
// SQLite. This file is the source end of that pipeline.

export type WatcherEvent =
  | { kind: 'add'; path: string; stats: Stats }
  | { kind: 'change'; path: string; stats: Stats }
  | { kind: 'unlink'; path: string }
  | { kind: 'error'; error: Error }

export type WatcherHandle = {
  // Resolves when chokidar's initial scan completes. Caller should await
  // this before treating subsequent events as live mutations.
  ready: Promise<void>
  // Tear down the watcher. Awaits chokidar's internal close.
  close(): Promise<void>
}

export type CreateWatcherOptions = {
  roots: string[]
  // Optional override for the ignore globs. Defaults to DEFAULT_EXCLUDE_GLOBS,
  // the same set the scanner uses, so watcher and scanner agree on what
  // counts as "in scope."
  ignored?: string[]
  onEvent: (event: WatcherEvent) => void
  // Test-only override for awaitWriteFinish; in production we want
  // the documented 200 ms / 50 ms tuning from the Slice 3 plan.
  awaitWriteFinish?: { stabilityThreshold: number; pollInterval: number }
}

export function createWatcher(opts: CreateWatcherOptions): WatcherHandle {
  // Compile globs into picomatch predicates ONCE at startup. chokidar v5
  // removed glob support from its `ignored` option; it now accepts a
  // function (path, stats) => boolean OR a Matcher array. picomatch is
  // the same matcher chokidar uses internally — using it here keeps
  // semantics consistent.
  //
  // NOTE: picomatch.compose does NOT exist (an earlier draft of the
  // Slice 3 plan referenced it). We compile each glob to its own
  // matcher and OR them together.
  const ignoreGlobs = opts.ignored ?? DEFAULT_EXCLUDE_GLOBS
  const matchers = ignoreGlobs.map(g => picomatch(g))
  const isIgnored = (p: string): boolean => matchers.some(m => m(p))

  const watcher: FSWatcher = chokidar.watch(opts.roots, {
    persistent: true,
    // Initial scan is mm scan's responsibility. The watcher only handles
    // the live delta after the cold start. ignoreInitial=true skips the
    // synthetic 'add' events chokidar would otherwise fire for every
    // existing file at startup.
    ignoreInitial: true,
    // Wait for files to stop changing before emitting. Lower than the
    // chokidar default (2 s) and lower than the original Slice 3 plan
    // (500 ms) — see plan revision: 200 ms is enough for typical editor
    // atomic-rename saves and saves us 300 ms of the 5 s ship-bar budget.
    awaitWriteFinish: opts.awaitWriteFinish ?? { stabilityThreshold: 200, pollInterval: 50 },
    // Per Slice 3 plan risk register: followSymlinks: false avoids loop
    // blow-ups on node_modules-style symlink farms or `ln -s . loop`.
    // Users who want symlinked content indexed must add the targets as
    // explicit scan roots.
    followSymlinks: false,
    // We need stats on every event for fingerprinting (mtime, size) and
    // for the inode+device rename pairing in Task 6.
    alwaysStat: true,
    ignored: (p, stats) => {
      // chokidar passes (path, stats) where stats may be undefined on
      // the directory-traversal phase. Match on the path string.
      return isIgnored(p)
    },
  })

  watcher.on('add', (p, stats) => {
    if (stats) opts.onEvent({ kind: 'add', path: p, stats })
  })
  watcher.on('change', (p, stats) => {
    if (stats) opts.onEvent({ kind: 'change', path: p, stats })
  })
  watcher.on('unlink', p => {
    opts.onEvent({ kind: 'unlink', path: p })
  })
  // addDir / unlinkDir are observed (chokidar must traverse them) but
  // not propagated upward. The watcher operates at file granularity.
  watcher.on('error', err => {
    opts.onEvent({ kind: 'error', error: err as Error })
  })

  const ready = new Promise<void>((resolve, reject) => {
    watcher.once('ready', resolve)
    watcher.once('error', reject)
  })

  return {
    ready,
    close: () => watcher.close(),
  }
}
