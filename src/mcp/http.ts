import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer, type DaemonClient } from './server.js'

export type StartHttpOptions = {
  daemon: DaemonClient
  urlPath: string
}

export type HttpListener = {
  url: string
  close: () => Promise<void>
}

export async function startMcpHttp(opts: StartHttpOptions): Promise<HttpListener> {
  const httpServer = http.createServer()
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    httpServer.once('error', onError)
    httpServer.listen({ host: '127.0.0.1', port: 0 }, () => {
      httpServer.off('error', onError)
      resolve()
    })
  })
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    httpServer.close()
    throw new Error('mmd MCP HTTP listener failed to bind to a port')
  }
  const url = `http://127.0.0.1:${address.port}/mcp`

  try {
    httpServer.on('request', (req, res) => {
      if (req.url !== '/mcp') {
        res.statusCode = 404
        res.end()
        return
      }
      if (req.method !== 'POST') {
        // Stateless mode does not need long-lived GET SSE streams; agents POST
        // each request and read the JSON response. GET/DELETE get 405.
        res.statusCode = 405
        res.setHeader('Allow', 'POST')
        res.end()
        return
      }

      // Stateless transports cannot be reused across requests (the SDK throws
      // if you try). Build a fresh server + transport per POST.
      void handlePost(req, res, opts.daemon)
    })

    // Ensure the discovery file's parent exists. With the default data dir
    // (`~/.local/share/machine-memory`) this is created by the installer, but
    // tests pass custom paths and a freshly-cloned machine has nothing on disk
    // yet — without this mkdir, startMcpHttp throws ENOENT and the daemon
    // refuses to start with a confusing message.
    fs.mkdirSync(path.dirname(opts.urlPath), { recursive: true })
    fs.writeFileSync(opts.urlPath, `${url}\n`)
  } catch (cause) {
    // Anything that throws after the bind must close the listener; otherwise
    // serverCore's teardownPartial has no handle to it and the loopback port
    // stays bound, answering 405 for the rest of the process lifetime.
    await closeHttpServer(httpServer)
    throw cause
  }

  return {
    url,
    close: async () => {
      try {
        fs.unlinkSync(opts.urlPath)
      } catch {
        /* ignore */
      }
      await closeHttpServer(httpServer)
    },
  }
}

async function closeHttpServer(httpServer: http.Server): Promise<void> {
  // close() alone waits for every accepted socket to close on its own, which
  // means an idle keepalive client (or a stuck POST) blocks shutdown until
  // SIGKILL — at which point the daemon skips its cleanup path and leaves
  // stale mcp.url / socket files behind. Force idle and active sockets shut
  // immediately so close()'s callback fires promptly.
  httpServer.closeIdleConnections()
  httpServer.closeAllConnections()
  await new Promise<void>(resolve => httpServer.close(() => resolve()))
}

async function handlePost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  daemon: DaemonClient,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })
  const server = createMcpServer({ daemon })
  // Register cleanup BEFORE handleRequest. Otherwise an early client
  // disconnect can fire 'close' before the listener attaches, leaking the
  // per-request server + transport under load or with flaky clients.
  let closed = false
  const closeStack = (): void => {
    if (closed) return
    closed = true
    void transport.close()
    void server.close()
  }
  res.once('close', closeStack)
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res)
  } catch (cause) {
    if (!res.headersSent) {
      try {
        res.statusCode = 500
        res.end(`mcp http error: ${(cause as Error).message}\n`)
      } catch {
        /* ignore */
      }
    }
  } finally {
    // If the response already ended without 'close' firing yet (rare but
    // possible in some Node versions), drive cleanup directly.
    if (res.writableEnded || res.destroyed) closeStack()
  }
}
