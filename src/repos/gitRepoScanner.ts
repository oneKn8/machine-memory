import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type Database from 'better-sqlite3'

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
        ignore: ['**/node_modules/**'],
      })

      for (const configPath of configs) {
        const repoRoot = path.dirname(path.dirname(configPath))
        insert.run({
          id: stableId(repoRoot),
          root_path: repoRoot,
          repo_name: path.basename(repoRoot),
          remote_url: getGitValue(repoRoot, ['config', '--get', 'remote.origin.url']),
          current_branch: getGitValue(repoRoot, ['branch', '--show-current']),
          last_commit_at: getGitValue(repoRoot, ['log', '-1', '--format=%cI']),
        })
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
