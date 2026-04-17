import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getDefaultScanRoots: vi.fn(),
  openDatabase: vi.fn(),
  scanFiles: vi.fn(),
  scanRepos: vi.fn(),
  close: vi.fn(),
}))

vi.mock('../../src/config/loadConfig.js', () => ({
  loadConfig: mockState.loadConfig,
}))

vi.mock('../../src/config/defaults.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/config/defaults.js')>()
  return {
    ...actual,
    getDefaultScanRoots: mockState.getDefaultScanRoots,
  }
})

vi.mock('../../src/index/db.js', () => ({
  openDatabase: mockState.openDatabase,
}))

vi.mock('../../src/scanner/fileScanner.js', () => ({
  scanFiles: mockState.scanFiles,
}))

vi.mock('../../src/repos/gitRepoScanner.js', () => ({
  scanRepos: mockState.scanRepos,
}))

import { runScan } from '../../src/cli/commands/scan.js'

describe('runScan', () => {
  beforeEach(() => {
    mockState.loadConfig.mockReset()
    mockState.getDefaultScanRoots.mockReset()
    mockState.openDatabase.mockReset()
    mockState.scanFiles.mockReset()
    mockState.scanRepos.mockReset()
    mockState.close.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prefers explicit roots and OCR mode over config and defaults', () => {
    const db = { close: mockState.close } as unknown as { close: () => void }
    mockState.openDatabase.mockReturnValue(db)
    mockState.scanRepos.mockReturnValue(1)
    mockState.scanFiles.mockReturnValue(2)
    mockState.loadConfig.mockReturnValue({ excludeGlobs: [] })

    runScan({
      root: [' /tmp/alpha ', '/tmp/alpha', '/tmp/beta', ' '],
      ocrMode: 'all',
    })

    expect(mockState.loadConfig).toHaveBeenCalledTimes(1)
    expect(mockState.getDefaultScanRoots).not.toHaveBeenCalled()
    expect(mockState.scanRepos).toHaveBeenCalledWith(db, ['/tmp/alpha', '/tmp/beta'])
    expect(mockState.scanFiles).toHaveBeenCalledWith(
      db,
      ['/tmp/alpha', '/tmp/beta'],
      expect.objectContaining({
        ocrMode: 'all',
        excludeGlobs: expect.any(Array),
      }),
    )
    expect(mockState.close).toHaveBeenCalledTimes(1)
  })

  it('falls back to config roots and config OCR mode', () => {
    const db = { close: mockState.close } as unknown as { close: () => void }
    mockState.openDatabase.mockReturnValue(db)
    mockState.loadConfig.mockReturnValue({
      roots: [' /cfg/one ', '/cfg/one', '/cfg/two'],
      ocrMode: 'screenshots',
      excludeGlobs: ['**/cache/**'],
    })
    mockState.scanRepos.mockReturnValue(3)
    mockState.scanFiles.mockReturnValue(4)

    runScan()

    expect(mockState.getDefaultScanRoots).not.toHaveBeenCalled()
    expect(mockState.scanRepos).toHaveBeenCalledWith(db, ['/cfg/one', '/cfg/two'])
    expect(mockState.scanFiles).toHaveBeenCalledWith(
      db,
      ['/cfg/one', '/cfg/two'],
      expect.objectContaining({
        ocrMode: 'screenshots',
        excludeGlobs: expect.arrayContaining(['**/cache/**']),
      }),
    )
    expect(mockState.loadConfig).toHaveBeenCalledTimes(3)
  })

  it('falls back to defaults when no config or explicit roots are provided', () => {
    const db = { close: mockState.close } as unknown as { close: () => void }
    mockState.openDatabase.mockReturnValue(db)
    mockState.getDefaultScanRoots.mockReturnValue(['/home/oneknight/projects', '/home/oneknight/Downloads'])
    mockState.loadConfig.mockReturnValue({ excludeGlobs: [] })
    mockState.scanRepos.mockReturnValue(5)
    mockState.scanFiles.mockReturnValue(6)

    runScan()

    expect(mockState.getDefaultScanRoots).toHaveBeenCalledTimes(1)
    expect(mockState.scanRepos).toHaveBeenCalledWith(db, [
      '/home/oneknight/projects',
      '/home/oneknight/Downloads',
    ])
    expect(mockState.scanFiles).toHaveBeenCalledWith(db, [
      '/home/oneknight/projects',
      '/home/oneknight/Downloads',
    ], expect.objectContaining({
      ocrMode: 'screenshots',
      excludeGlobs: expect.any(Array),
    }))
    expect(mockState.loadConfig).toHaveBeenCalledTimes(3)
  })
})
