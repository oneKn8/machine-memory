import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SearchResult } from '../types.js'
import type { LoadedRecord } from '../index/loadRecord.js'
import {
  FindInputSchema, FindResultSchema,
  GetInputSchema, GetResultSchema,
  RecentInputSchema, RecentResultSchema,
} from './types.js'

export type DaemonClient = {
  call: <R = unknown>(method: string, params: unknown) => Promise<R>
}

export type CreateMcpServerOptions = {
  daemon: DaemonClient
  serverName?: string
  serverVersion?: string
}

export function createMcpServer(opts: CreateMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: opts.serverName ?? 'machine-memory', version: opts.serverVersion ?? '0.1.0' },
    {
      instructions:
        'Use mm_find before running grep/ls/find on the user\'s machine. Each result includes a resource_link you can resolve. Call mm_get for the full record (including text snippets) when you need to read deeper.',
    },
  )

  server.registerTool(
    'mm_find',
    {
      title: 'Search the local machine memory',
      description:
        'Search the local machine\'s indexed memory (files, repos, PDFs, screenshots, code). Returns ranked results with provenance and resource_link entries you can fetch.',
      inputSchema: FindInputSchema.shape,
      outputSchema: FindResultSchema.shape,
    },
    async ({ query }) => {
      try {
        const results = await opts.daemon.call<SearchResult[]>('mm_find', { query })
        const structured = {
          query,
          results: results.map(r => ({
            id: r.resultId,
            kind: r.resultType,
            path: r.path,
            title: r.title,
            score: r.score,
            last_modified: r.lastModified,
            why_matched: r.whyMatched,
          })),
        }
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(structured, null, 2) },
            ...results.map(r => ({
              type: 'resource_link' as const,
              uri: pathToFileURL(r.path).href,
              name: r.title,
            })),
          ],
          structuredContent: structured,
        }
      } catch (cause) {
        return {
          content: [{ type: 'text' as const, text: `mm_find failed: ${(cause as Error).message}` }],
          isError: true,
        }
      }
    },
  )

  server.registerTool(
    'mm_get',
    {
      title: 'Fetch a single indexed record',
      description: 'Fetch one indexed record by id. Returns the full file/repo metadata and any extracted text blob snippets.',
      inputSchema: GetInputSchema.shape,
      outputSchema: GetResultSchema.shape,
    },
    async ({ id }) => {
      try {
        const record = await opts.daemon.call<LoadedRecord>('mm_get', { id })
        const structured = { id, record }
        return {
          content: record === null
            ? [{ type: 'text' as const, text: `no record found for id ${id}` }]
            : [{ type: 'text' as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        }
      } catch (cause) {
        return {
          content: [{ type: 'text' as const, text: `mm_get failed: ${(cause as Error).message}` }],
          isError: true,
        }
      }
    },
  )

  // Slice 2 backs this with file_records.modified_at; Phase 2 will switch to
  // the activity event stream. Kept out of the user-facing description so we
  // don't leak implementation detail into agent prompts.
  server.registerTool(
    'mm_recent',
    {
      title: 'List recently modified files',
      description: 'Return recently modified files from the index, optionally filtered by a since timestamp.',
      inputSchema: RecentInputSchema.shape,
      outputSchema: RecentResultSchema.shape,
    },
    async ({ since, limit }) => {
      try {
        const results = await opts.daemon.call<SearchResult[]>('mm_recent', { since, limit })
        const structured = {
          results: results.map(r => ({
            id: r.resultId,
            path: r.path,
            title: r.title,
            last_modified: r.lastModified,
          })),
        }
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(structured, null, 2) },
            ...results.map(r => ({
              type: 'resource_link' as const,
              uri: pathToFileURL(r.path).href,
              name: r.title,
            })),
          ],
          structuredContent: structured,
        }
      } catch (cause) {
        return {
          content: [{ type: 'text' as const, text: `mm_recent failed: ${(cause as Error).message}` }],
          isError: true,
        }
      }
    },
  )

  return server
}
