export type DaemonRequest<P = unknown> = {
  id: string
  method: string
  params?: P
}

export type DaemonResponse<R = unknown> = {
  id: string
  result?: R
  error?: { code: number; message: string; data?: unknown }
}

export type DaemonMessage = DaemonRequest | DaemonResponse

export function encodeMessage(message: DaemonMessage): string {
  return `${JSON.stringify(message)}\n`
}

export class MessageDecoder {
  private buffer = ''

  push(chunk: string): DaemonMessage[] {
    this.buffer += chunk
    const messages: DaemonMessage[] = []
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.length > 0) {
        try {
          messages.push(JSON.parse(line) as DaemonMessage)
        } catch (cause) {
          throw new Error(`failed to parse daemon message: ${(cause as Error).message}`)
        }
      }
      newlineIndex = this.buffer.indexOf('\n')
    }
    return messages
  }
}
