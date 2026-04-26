import { z } from 'zod'

// Slice 2 only forwards `query`. Filters (kinds, path_prefix, since, limit)
// are real Phase-2/Phase-3 work — re-add to this schema as the daemon
// gains filtering. Advertising filters that don't work would lie to agents.
export const FindInputSchema = z.object({
  query: z.string().min(1).describe('Natural language or keyword search query'),
})

export const FindResultSchema = z.object({
  query: z.string(),
  results: z.array(z.object({
    id: z.string(),
    kind: z.enum(['file', 'repo', 'directory']),
    path: z.string(),
    title: z.string(),
    score: z.number(),
    last_modified: z.string().optional(),
    why_matched: z.string(),
  })),
})

export const GetInputSchema = z.object({
  id: z.string().describe('Result id from a prior mm_find call'),
})

export const GetResultSchema = z.object({
  id: z.string(),
  record: z.union([
    z.object({
      kind: z.literal('file'),
      record: z.record(z.string(), z.unknown()),
      blobs: z.array(z.object({ extractor_type: z.string(), snippet: z.string() })),
    }),
    z.object({
      kind: z.literal('repo'),
      record: z.record(z.string(), z.unknown()),
      blobs: z.array(z.object({ extractor_type: z.string(), snippet: z.string() })),
    }),
    z.null(),
  ]),
})

export const RecentInputSchema = z.object({
  since: z.iso.datetime().optional().describe('ISO 8601 timestamp; only events at or after'),
  limit: z.number().int().min(1).max(100).default(20),
})

export const RecentResultSchema = z.object({
  results: z.array(z.object({
    id: z.string(),
    path: z.string(),
    title: z.string(),
    last_modified: z.string().optional(),
  })),
})
