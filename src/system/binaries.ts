import { execFileSync } from 'node:child_process'

export function hasBinary(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
