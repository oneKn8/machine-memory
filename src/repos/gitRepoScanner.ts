import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type Database from 'better-sqlite3'
import { upsertTextBlob } from '../index/textBlobs.js'

export function scanRepos(db: Database.Database, roots: string[]): number {
  const insert = db.prepare(`
    INSERT INTO repo_records (
      id, root_path, repo_name, remote_url, current_branch, last_commit_at
    ) VALUES (
      @id, @root_path, @repo_name, @remote_url, @current_branch, @last_commit_at
    )
    ON CONFLICT(root_path) DO UPDATE SET
      repo_name=excluded.repo_name,
      remote_url=excluded.remote_url,
      current_branch=excluded.current_branch,
      last_commit_at=excluded.last_commit_at
  `)

  let count = 0
  const tx = db.transaction(() => {
    for (const root of roots) {
      if (!fs.existsSync(root)) continue

      const configs = fg.sync(['**/.git/config'], {
        cwd: root,
        absolute: true,
        dot: true,
        followSymbolicLinks: false,
        suppressErrors: true,
        ignore: ['**/node_modules/**', '**/.pgdata/**', '**/.cache/**'],
      })

      for (const configPath of configs) {
        const repoRoot = path.dirname(path.dirname(configPath))
        const id = stableId(repoRoot)
        const remoteUrl = getGitValue(repoRoot, ['config', '--get', 'remote.origin.url'])
        const readme = findRepoReadme(repoRoot)
        const packageManifest = findPackageManifest(repoRoot)
        const summary = buildRepoSummary(repoRoot, remoteUrl, readme, packageManifest)

        insert.run({
          id,
          root_path: repoRoot,
          repo_name: path.basename(repoRoot),
          remote_url: remoteUrl,
          current_branch: getGitValue(repoRoot, ['branch', '--show-current']),
          last_commit_at: getGitValue(repoRoot, ['log', '-1', '--format=%cI']),
        })

        if (summary) {
          upsertTextBlob(db, {
            sourceId: id,
            sourceType: 'repo',
            extractorType: 'repo_summary',
            content: summary,
          })
        }
        count += 1
      }
    }
  })

  tx()
  return count
}

function getGitValue(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function stableId(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function findRepoReadme(repoRoot: string): string | null {
  const entries = ['README.md', 'README.MD', 'readme.md', 'README.txt', 'README']
  for (const entry of entries) {
    const candidate = path.join(repoRoot, entry)
    if (!fs.existsSync(candidate)) continue
    try {
      return fs.readFileSync(candidate, 'utf8').slice(0, 32 * 1024)
    } catch {
      return null
    }
  }
  return null
}

function findPackageManifest(repoRoot: string): string | null {
  const candidate = path.join(repoRoot, 'package.json')
  if (!fs.existsSync(candidate)) return null
  try {
    return fs.readFileSync(candidate, 'utf8').slice(0, 16 * 1024)
  } catch {
    return null
  }
}

function buildRepoSummary(
  repoRoot: string,
  remoteUrl: string | null,
  readme: string | null,
  packageManifest: string | null,
): string {
  const parts = [`repo: ${path.basename(repoRoot)}`]
  if (remoteUrl) parts.push(`remote: ${remoteUrl}`)
  if (readme) parts.push(`readme:\n${readme}`)
  if (packageManifest) parts.push(`package:\n${packageManifest}`)
  return parts.join('\n\n')
}
