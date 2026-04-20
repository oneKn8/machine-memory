import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runFind } from '../../src/cli/commands/find.js'
import { runShow } from '../../src/cli/commands/show.js'
import { getDaemonSocketPath } from '../../src/daemon/paths.js'
import { openDatabase } from '../../src/index/db.js'
import { upsertTextBlob } from '../../src/index/textBlobs.js'

const mockState = vi.hoisted(() => ({
  tempHome: '',
}))

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = (): string => mockState.tempHome || actual.homedir()

  return {
    ...actual,
    default: {
      ...actual,
      homedir,
    },
    homedir,
  }
})

type SeedRecord = {
  id: string
  path: string
  name: string
  extension?: string | null
  mimeType?: string | null
  modifiedAt?: string | null
  sourceRoot?: string | null
  metadataJson?: string | null
}

type RepoSeedRecord = {
  id: string
  rootPath: string
  repoName: string
  remoteUrl?: string | null
  currentBranch?: string | null
  lastCommitAt?: string | null
}

describe('CLI commands', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-'))
    mockState.tempHome = tempHome
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mockState.tempHome = ''
    delete process.env.MM_DATA_DIR
    process.exitCode = 0
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  it('falls through to direct DB when no daemon is reachable', async () => {
    process.env.MM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-find-fallback-'))
    // Seed an empty DB so the direct path runs without errors.
    const { openDatabase } = await import('../../src/index/db.js')
    openDatabase().close()

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(line => {
      logs.push(String(line))
    })
    await runFind('anything')
    expect(logs.join('\n')).toMatch(/no matches/i)
  })

  it('falls through to direct DB when daemon errors mid-call', async () => {
    // Point both daemon paths and the DB at an isolated tmp dir so we own
    // the socket file and the (empty) DB used by the direct fallback.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-find-broken-daemon-'))
    process.env.MM_DATA_DIR = dataDir
    // Seed an empty DB so the fallback path opens cleanly.
    const { openDatabase } = await import('../../src/index/db.js')
    openDatabase().close()

    // Stand up a "broken" daemon: a raw socket server that accepts the
    // connection (so isDaemonReachable returns true) but writes garbage
    // instead of valid NDJSON, forcing call() to reject during decode.
    const socketPath = getDaemonSocketPath()
    const server = net.createServer(socket => {
      socket.on('data', () => {
        socket.write('not-valid-json\n')
      })
      socket.on('error', () => {
        /* ignore — peer may close once call() rejects */
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => resolve())
    })

    const logs: string[] = []
    const errors: string[] = []
    vi.spyOn(console, 'log').mockImplementation(line => {
      logs.push(String(line))
    })
    vi.spyOn(console, 'error').mockImplementation(line => {
      errors.push(String(line))
    })

    try {
      await runFind('anything')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      try {
        fs.unlinkSync(socketPath)
      } catch {
        /* already removed by server.close */
      }
      fs.rmSync(dataDir, { recursive: true, force: true })
    }

    // Daemon warning landed on stderr, results from the direct DB path
    // landed on stdout, and runFind resolved cleanly (no unhandled reject).
    expect(errors.join('\n')).toMatch(/mmd:.*falling back to direct DB/i)
    expect(logs.join('\n')).toMatch(/no matches/i)
    expect(process.exitCode).toBe(0)
  })

  it('prints path matches in descending modified order', async () => {
    seedFiles([
      {
        id: 'file-old',
        path: '/captures/screenshots/old-shot.png',
        name: 'old-shot.png',
        extension: 'png',
        modifiedAt: '2026-04-10T08:00:00.000Z',
      },
      {
        id: 'file-new',
        path: '/captures/screenshots/new-shot.png',
        name: 'new-shot.png',
        extension: 'png',
        modifiedAt: '2026-04-12T08:00:00.000Z',
      },
      {
        id: 'file-other',
        path: '/captures/documents/notes.txt',
        name: 'notes.txt',
        extension: 'txt',
        modifiedAt: '2026-04-13T08:00:00.000Z',
      },
    ])

    await runFind('SCREENSHOTS')

    expect(console.log).toHaveBeenCalledTimes(1)
    expect(console.log).toHaveBeenCalledWith(
      [
        '1. new-shot.png',
        '   type: file',
        '   path: /captures/screenshots/new-shot.png',
        '   why: Matched file name or path text',
        '   modified: 2026-04-12T08:00:00.000Z',
        '',
        '2. old-shot.png',
        '   type: file',
        '   path: /captures/screenshots/old-shot.png',
        '   why: Matched file name or path text',
        '   modified: 2026-04-10T08:00:00.000Z',
      ].join('\n'),
    )
  })

  it('prints an empty-state message when nothing matches', async () => {
    seedFiles([
      {
        id: 'file-1',
        path: '/captures/documents/notes.txt',
        name: 'notes.txt',
        extension: 'txt',
        modifiedAt: '2026-04-13T08:00:00.000Z',
      },
    ])

    await runFind('quarterly report')

    expect(console.log).toHaveBeenCalledWith('No matches found.')
  })

  it('prints indexed file details and blanks nullable fields', () => {
    seedFiles([
      {
        id: 'file-1',
        path: '/captures/documents/overview',
        name: 'overview',
        extension: null,
        modifiedAt: null,
        sourceRoot: null,
      },
    ])

    runShow('file-1')

    expect(readLogLines()).toEqual([
      'type: file',
      'name: overview',
      'path: /captures/documents/overview',
      'extension: ',
      'modified: ',
      'source root: ',
    ])
    expect(process.exitCode).toBe(0)
  })

  it('prints trusted file details, metadata, and indexed text', () => {
    seedFiles([
      {
        id: 'file-trust',
        path: '/captures/screenshots/colorado-trip.png',
        name: 'colorado-trip.png',
        extension: 'png',
        mimeType: 'image/png',
        modifiedAt: '2026-04-15T20:00:00.000Z',
        sourceRoot: '/captures',
        metadataJson: JSON.stringify({
          fileCategory: 'image',
          isScreenshot: true,
          city: 'Boulder',
          state: 'Colorado',
        }),
      },
    ])
    seedTextBlob({
      sourceId: 'file-trust',
      sourceType: 'file',
      extractorType: 'screenshot_metadata',
      content: 'image: colorado-trip.png\ncategory: screenshot\nlocation: Boulder, Colorado',
    })
    seedTextBlob({
      sourceId: 'file-trust',
      sourceType: 'file',
      extractorType: 'screenshot_ocr',
      content: 'Colorado trip with my sister near the mountains',
    })

    runShow('file-trust')

    expect(readLogLines()).toEqual([
      'type: file',
      'name: colorado-trip.png',
      'path: /captures/screenshots/colorado-trip.png',
      'extension: png',
      'mime: image/png',
      'modified: 2026-04-15T20:00:00.000Z',
      'source root: /captures',
      'metadata: {"fileCategory":"image","isScreenshot":true,"city":"Boulder","state":"Colorado"}',
      'indexed text:',
      '- screenshot_metadata: image: colorado-trip.png category: screenshot location: Boulder, Colorado',
      '- screenshot_ocr: Colorado trip with my sister near the mountains',
    ])
  })

  it('prints indexed repo details', () => {
    seedRepos([
      {
        id: 'repo-1',
        rootPath: '/projects/machine-memory',
        repoName: 'machine-memory',
        remoteUrl: 'git@github.com:oneKn8/machine-memory.git',
        currentBranch: 'main',
        lastCommitAt: '2026-04-16T02:00:00.000Z',
      },
    ])

    runShow('repo-1')

    expect(readLogLines()).toEqual([
      'type: repo',
      'name: machine-memory',
      'path: /projects/machine-memory',
      'remote: git@github.com:oneKn8/machine-memory.git',
      'branch: main',
      'last commit: 2026-04-16T02:00:00.000Z',
    ])
  })

  it('sets a non-zero exit code when show cannot find a record', () => {
    runShow('missing-id')

    expect(console.error).toHaveBeenCalledWith('No result found for id: missing-id')
    expect(process.exitCode).toBe(1)
    expect(console.log).not.toHaveBeenCalled()
  })
})

function seedFiles(records: SeedRecord[]): void {
  const db = openDatabase()
  const insert = db.prepare(`
    INSERT INTO file_records (
      id,
      path,
      name,
      extension,
      mime_type,
      modified_at,
      source_root,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertMany = db.transaction((rows: SeedRecord[]) => {
    for (const row of rows) {
      insert.run(
        row.id,
        row.path,
        row.name,
        row.extension ?? null,
        row.mimeType ?? null,
        row.modifiedAt ?? null,
        row.sourceRoot ?? null,
        row.metadataJson ?? null,
      )
    }
  })

  insertMany(records)
  db.close()
}

function seedTextBlob(input: Parameters<typeof upsertTextBlob>[1]): void {
  const db = openDatabase()
  upsertTextBlob(db, input)
  db.close()
}

function seedRepos(records: RepoSeedRecord[]): void {
  const db = openDatabase()
  const insert = db.prepare(`
    INSERT INTO repo_records (
      id,
      root_path,
      repo_name,
      remote_url,
      current_branch,
      last_commit_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)

  const insertMany = db.transaction((rows: RepoSeedRecord[]) => {
    for (const row of rows) {
      insert.run(
        row.id,
        row.rootPath,
        row.repoName,
        row.remoteUrl ?? null,
        row.currentBranch ?? null,
        row.lastCommitAt ?? null,
      )
    }
  })

  insertMany(records)
  db.close()
}

function readLogLines(): string[] {
  return vi.mocked(console.log).mock.calls.map(call => String(call[0]))
}
