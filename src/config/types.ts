export type OcrMode = 'off' | 'screenshots' | 'all'

export type MachineMemoryConfig = {
  roots?: string[]
  ocrMode?: OcrMode
  excludeGlobs?: string[]
}
