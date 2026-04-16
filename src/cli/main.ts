#!/usr/bin/env node
import { Command } from 'commander'
import { runDoctor } from './commands/doctor.js'
import { runFind } from './commands/find.js'
import { runScan } from './commands/scan.js'
import { runShow } from './commands/show.js'
import type { OcrMode } from '../config/types.js'

const program = new Command()

program
  .name('mm')
  .description('Machine Memory: search your machine by memory, not filename')
  .version('0.1.0')

program
  .command('scan')
  .description('Scan configured roots')
  .option('-r, --root <path>', 'add a scan root for this run', collect, [])
  .option('--ocr-mode <mode>', 'OCR mode: off, screenshots, or all', parseOcrMode)
  .action(runScan)

program
  .command('find')
  .description('Find files, repos, images, or documents')
  .argument('<query>', 'search query')
  .action(runFind)

program
  .command('show')
  .description('Show one indexed result')
  .argument('<id>', 'indexed result id')
  .action(runShow)

program.command('doctor').description('Check local setup').action(runDoctor)

program.parse()

function collect(value: string, previous: string[]): string[] {
  previous.push(value)
  return previous
}

function parseOcrMode(value: string): OcrMode {
  const normalized = value.trim().toLowerCase()

  if (normalized === 'off' || normalized === 'screenshots' || normalized === 'all') {
    return normalized
  }

  throw new Error(`Invalid OCR mode: ${value}. Expected one of off, screenshots, all.`)
}
