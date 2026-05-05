// Worker entry for the extraction pool. Runs CPU-bound extractor work
// off the main thread so the daemon's RPC + writer queue stay responsive
// while files are being indexed.
//
// MUST NOT import better-sqlite3 (or anything that pulls it in
// transitively). better-sqlite3 is synchronous and not safe to share
// across threads — single-writer-on-main is the only correct shape.
// The only allowed dependencies here are node built-ins and the pure
// extractor modules under src/extractors/, src/media/, src/ocr/.

import { parentPort } from 'node:worker_threads'
import { extractTextFromFileResult } from '../extractors/textExtractor.js'
import { extractImageMetadata, isImageFile } from '../media/imageMetadata.js'
import { extractImageOcr } from '../ocr/imageOcr.js'

export type ExtractionJobOptions = {
  // Run image OCR if this file is an image AND the predicate (evaluated
  // on the main thread before dispatch) said yes. Workers don't decide
  // policy; they execute.
  runImageOcr: boolean
}

export type ExtractionJobResult = {
  text: { success: boolean; content: string | null; extractorType: string | null } | null
  image: { mimeType: string | null; isImage: boolean; isScreenshot: boolean; raw: Record<string, unknown>; summaryText: string | null } | null
  ocr: { success: boolean; content: string | null; extractorType: string | null } | null
}

export type WorkerInbound =
  | { kind: 'extract'; jobId: number; filePath: string; options: ExtractionJobOptions }
  | { kind: 'shutdown' }

export type WorkerOutbound =
  | { kind: 'ready' }
  | { kind: 'result'; jobId: number; result: ExtractionJobResult }
  | { kind: 'error'; jobId: number; message: string }

function runJob(filePath: string, options: ExtractionJobOptions): ExtractionJobResult {
  const text = (() => {
    const r = extractTextFromFileResult(filePath)
    return { success: r.success, content: r.content, extractorType: r.extractorType }
  })()

  const isImg = isImageFile(filePath)
  const image = isImg ? extractImageMetadata(filePath) : null

  const ocr = isImg && options.runImageOcr
    ? (() => {
        const r = extractImageOcr(filePath)
        return { success: r.success, content: r.content, extractorType: r.extractorType }
      })()
    : null

  return { text, image, ocr }
}

if (parentPort) {
  parentPort.on('message', (msg: WorkerInbound) => {
    if (msg.kind === 'shutdown') {
      // Let the main thread observe a clean exit. The pool's close()
      // posts shutdown after every in-flight job has settled, so by the
      // time we get here the worker is idle.
      process.exit(0)
    }
    if (msg.kind === 'extract') {
      try {
        const result = runJob(msg.filePath, msg.options)
        const out: WorkerOutbound = { kind: 'result', jobId: msg.jobId, result }
        parentPort!.postMessage(out)
      } catch (err) {
        // Per Slice 3 plan risk register (unreadable files / EACCES /
        // extractor crash on malformed input): catch and report, never
        // crash the worker. The main thread treats this as a file with
        // empty extraction results.
        const out: WorkerOutbound = {
          kind: 'error',
          jobId: msg.jobId,
          message: (err as Error).message ?? String(err),
        }
        parentPort!.postMessage(out)
      }
    }
  })

  // Signal readiness so the pool can start dispatching after construction.
  const ready: WorkerOutbound = { kind: 'ready' }
  parentPort.postMessage(ready)
}
