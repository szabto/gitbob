import { spawn, execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

/**
 * A real smart-HTTP Git server for tests: Node http in front of `git http-backend`
 * (CGI), protected with HTTP Basic auth. Serves bare repositories under `projectRoot`.
 */
export async function startHttpGitServer(opts: {
  projectRoot: string
  username: string
  password: string
}): Promise<{ url: string; close: () => Promise<void>; authAttempts: () => number }> {
  const backend = join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend')
  const expected = 'Basic ' + Buffer.from(`${opts.username}:${opts.password}`).toString('base64')
  let attempts = 0

  const server: Server = createServer((req, res) => {
    if (req.headers.authorization) attempts++
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="gitbob-test"' })
      res.end('unauthorized')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const cgi = spawn(backend, [], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: opts.projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_CONFIG_NOSYSTEM: '1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: opts.username,
        REMOTE_ADDR: '127.0.0.1',
        ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
        ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
      },
    })
    req.pipe(cgi.stdin)
    let head = Buffer.alloc(0)
    let headersDone = false
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk)
        return
      }
      head = Buffer.concat([head, chunk])
      const sep = head.indexOf('\r\n\r\n')
      if (sep === -1) return
      headersDone = true
      let status = 200
      for (const line of head.subarray(0, sep).toString('utf8').split('\r\n')) {
        const i = line.indexOf(':')
        const k = line.slice(0, i).trim()
        const v = line.slice(i + 1).trim()
        if (k.toLowerCase() === 'status') status = Number(v.split(' ')[0])
        else res.setHeader(k, v)
      }
      res.writeHead(status)
      res.write(head.subarray(sep + 4))
    })
    cgi.on('close', () => res.end())
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    authAttempts: () => attempts,
    close: () => new Promise((r) => server.close(() => r())),
  }
}
