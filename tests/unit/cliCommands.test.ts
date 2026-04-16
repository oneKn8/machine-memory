import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runFind } from '../../src/cli/commands/find.js'
import { runShow } from '../../src/cli/commands/show.js'
import { openDatabase } from '../../src/index/db.js'

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
  modifiedAt?: string | null
  sourceRoot?: string | null
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
    process.exitCode = 0
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  it('prints path matches in descending modified order', () => {
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

    runFind('SCREENSHOTS')

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

  it('prints an empty-state message when nothing matches', () => {
    seedFiles([
      {
        id: 'file-1',
        path: '/captures/documents/notes.txt',
        name: 'notes.txt',
        extension: 'txt',
        modifiedAt: '2026-04-13T08:00:00.000Z',
      },
    ])

    runFind('quarterly report')

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
      'name: overview',
      'path: /captures/documents/overview',
      'extension: ',
      'modified: ',
      'source root: ',
    ])
    expect(process.exitCode).toBe(0)
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
      modified_at,
      source_root
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)

  const insertMany = db.transaction((rows: SeedRecord[]) => {
    for (const row of rows) {
      insert.run(
        row.id,
        row.path,
        row.name,
        row.extension ?? null,
        row.modifiedAt ?? null,
        row.sourceRoot ?? null,
      )
    }
  })

  insertMany(records)
  db.close()
}

function readLogLines(): string[] {
  return vi.mocked(console.log).mock.calls.map(call => String(call[0]))
}
