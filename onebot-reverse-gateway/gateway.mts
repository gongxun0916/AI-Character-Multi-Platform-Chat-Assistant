import { createServer } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'

type ObjectValue = Record<string, unknown>
const object = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown): string | null => typeof v === 'string' && /^-?[0-9]{1,20}$/.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : null

export type Config = {
  host: string; port: number; path: string; selfId: string; owners: string[]; umo: string
  upstream: string; stateDir: string; wsToken: string; upstreamToken: string
  maxPayload: number; maxTextBytes: number; maxResponseBytes: number; maxReplyBytes: number
  maxQueue: number; maxDedupe: number; turnTimeoutMs: number; controlTimeoutMs: number
  sendTimeoutMs: number; heartbeatMs: number
}

export function configFrom(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  if (!object(raw)) throw new Error('invalid config')
  const text = (key: string): string => {
    const value = raw[key]
    if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\r\n\0]/.test(value)) throw new Error(`invalid ${key}`)
    return value
  }
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const value = raw[key] ?? fallback
    if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`invalid ${key}`)
    return Number(value)
  }
  const secret = (key: string): string => {
    const value = env[text(key)]
    if (!value || value.length < 32 || value.length > 1024 || /[\r\n\0]/.test(value) || value.startsWith('REPLACE_')) throw new Error(`invalid secret ${key}`)
    return value
  }
  const upstream = new URL(text('upstream'))
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== '/') throw new Error('upstream must be an origin')
  if (upstream.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(upstream.hostname)) throw new Error('remote upstream requires HTTPS')
  const owners = raw.owners
  if (!Array.isArray(owners) || owners.length < 1 || owners.length > 32 || !owners.every(v => typeof v === 'string' && id(v) === v && !v.startsWith('-') && v !== '0')) throw new Error('invalid owners')
  const selfId = text('selfId')
  if (!id(selfId) || selfId.startsWith('-') || selfId === '0') throw new Error('invalid selfId')
  const path = text('path')
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(path)) throw new Error('invalid path')
  const stateDir = text('stateDir')
  if (!isAbsolute(stateDir)) throw new Error('stateDir must be absolute')
  return {
    host: text('host'), port: number('port', 3190, 1, 65535), path, selfId, owners,
    umo: text('umo'), upstream: upstream.origin, stateDir,
    wsToken: secret('wsTokenEnv'), upstreamToken: secret('upstreamTokenEnv'),
    maxPayload: number('maxPayload', 65536, 1024, 1048576),
    maxTextBytes: number('maxTextBytes', 8192, 1, 65536),
    maxResponseBytes: number('maxResponseBytes', 1048576, 1024, 16777216),
    maxReplyBytes: number('maxReplyBytes', 12000, 128, 65536),
    maxQueue: number('maxQueue', 16, 1, 256), maxDedupe: number('maxDedupe', 100000, 1, 1000000),
    turnTimeoutMs: number('turnTimeoutMs', 180000, 100, 3600000),
    controlTimeoutMs: number('controlTimeoutMs', 5000, 50, 30000),
    sendTimeoutMs: number('sendTimeoutMs', 5000, 50, 30000),
    heartbeatMs: number('heartbeatMs', 30000, 100, 120000)
  }
}

type State = { version: 1; blocked: boolean; inflight: boolean; seen: string[] }
export class Store {
  state: State
  private file: string
  private lock: string
  private config: Config
  constructor(config: Config) {
    this.config = config
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
    this.file = join(config.stateDir, 'state.json')
    this.lock = join(config.stateDir, 'instance.lock')
    mkdirSync(this.lock, { mode: 0o700 })
    try {
      if (existsSync(this.file)) {
        if (statSync(this.file).size > config.maxDedupe * 80 + 1024) throw new Error('state too large')
        const s: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
        if (!object(s) || s.version !== 1 || typeof s.blocked !== 'boolean' || typeof s.inflight !== 'boolean' || !Array.isArray(s.seen) || s.seen.length > config.maxDedupe || !s.seen.every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) throw new Error('invalid state')
        this.state = s as State
      } else this.state = { version: 1, blocked: false, inflight: false, seen: [] }
      if (this.state.inflight) this.state.blocked = true
      this.save()
    } catch (error) {
      rmdirSync(this.lock)
      throw error
    }
  }
  save() {
    const fd = openSync(`${this.file}.tmp`, 'w', 0o600)
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(`${this.file}.tmp`, this.file)
    const directory = openSync(this.config.stateDir, 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
  claim(key: string): boolean {
    if (this.state.blocked || this.state.seen.includes(key)) return false
    if (this.state.seen.length >= this.config.maxDedupe) { this.block(); return false }
    this.state.seen.push(key)
    this.save()
    return true
  }
  block() { this.state.blocked = true; this.save() }
  close() { rmdirSync(this.lock) }
}

export function inbound(event: unknown, c: Config): { user: string; text: string; key: string } | null {
  if (!object(event) || event.post_type !== 'message' || event.message_type !== 'private' || event.sub_type !== 'friend' || id(event.self_id) !== c.selfId || event.group_id !== undefined) return null
  const user = id(event.user_id)
  const message = id(event.message_id)
  if (!user || !message || !c.owners.includes(user) || user === c.selfId) return null
  let text: string
  if (typeof event.message === 'string') {
    if (/\[CQ:/i.test(event.message)) return null
    text = event.message.replaceAll('&#91;', '[').replaceAll('&#93;', ']').replaceAll('&#44;', ',').replaceAll('&amp;', '&')
  } else if (Array.isArray(event.message) && event.message.length > 0 && event.message.every(s => object(s) && s.type === 'text' && object(s.data) && typeof s.data.text === 'string')) {
    text = event.message.map(s => s.data.text).join('')
  } else return null
  if (!text.trim() || text.includes('\0') || Buffer.byteLength(text) > c.maxTextBytes) return null
  return { user, text, key: createHash('sha256').update(JSON.stringify([c.selfId, user, message])).digest('hex') }
}

class UnsafeTurn extends Error {}
async function stream(c: Config, user: string, text: string, timeout: number, control = false): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetch(`${c.upstream}/inbound`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${c.upstreamToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ umo: c.umo, senderId: user, chatType: 'private', text, progress: { mode: 'off' } })
    })
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('upstream rejected')
    reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffer = '', output = '', size = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('SSE missing done')
      size += chunk.value.byteLength
      if (size > c.maxResponseBytes) throw new Error('upstream too large')
      buffer += decoder.decode(chunk.value, { stream: true })
      buffer = buffer.replaceAll('\r\n', '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary).replaceAll('\r', '')
        buffer = buffer.slice(boundary + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (!data.length) continue
        const value: unknown = JSON.parse(data.join('\n'))
        if (!object(value)) throw new Error('invalid SSE data')
        if (event === 'approval' || event === 'question') throw new UnsafeTurn('human interaction refused')
        if (event === 'error') throw new Error('upstream error')
        if (event === 'text' && !control) {
          if (typeof value.text !== 'string') throw new Error('invalid text')
          output += (output ? '\n' : '') + value.text
          if (Buffer.byteLength(output) > c.maxReplyBytes) throw new Error('reply too large')
        }
        if (event === 'done') return output
      }
    }
  } finally {
    controller.abort()
    await reader?.cancel().catch(() => {})
    clearTimeout(timer)
  }
}

export async function createGateway(c: Config) {
  const store = new Store(c)
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (_req, res) => {
    res.writeHead(404, { Connection: 'close' }); res.end()
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  const wss = new WebSocketServer({ noServer: true, maxPayload: c.maxPayload, perMessageDeflate: false })
  let active: WebSocket | undefined
  let reserved = false, closing = false, queued = 0
  let chain = Promise.resolve()
  const pending = new Map<string, { ws: WebSocket; resolve: () => void; reject: () => void }>()
  const digest = (s: string) => createHash('sha256').update(s).digest()
  server.on('upgrade', (req, socket, head) => {
    const authorized = timingSafeEqual(digest(req.headers.authorization ?? ''), digest(`Bearer ${c.wsToken}`))
    const valid = authorized && req.url === c.path && req.headers['x-self-id'] === c.selfId && req.headers['x-client-role'] === 'Universal'
    if (!valid || active || reserved || closing) { socket.end(`HTTP/1.1 ${valid ? '409 Conflict' : '403 Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return }
    reserved = true
    try { wss.handleUpgrade(req, socket, head, ws => { reserved = false; wss.emit('connection', ws) }) }
    catch { reserved = false; socket.destroy() }
  })
  async function send(ws: WebSocket, user: string, text: string) {
    if (ws !== active || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > c.maxPayload) throw new Error('connection unavailable')
    const echo = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(echo); reject(new Error('send result unknown')) }, c.sendTimeoutMs)
      const finish = (ok: boolean) => { clearTimeout(timer); pending.delete(echo); if (ok) resolve(); else reject(new Error('send failed')) }
      pending.set(echo, { ws, resolve: () => finish(true), reject: () => finish(false) })
      ws.send(JSON.stringify({ action: 'send_private_msg', params: { user_id: user, message: [{ type: 'text', data: { text } }], auto_escape: true }, echo }), error => { if (error) finish(false) })
    })
  }
  wss.on('connection', (ws: WebSocket) => {
    active = ws
    let alive = true
    ws.on('pong', () => { alive = true })
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping() } }, c.heartbeatMs)
    ws.on('error', () => {})
    ws.on('close', () => {
      clearInterval(heartbeat)
      if (active === ws) active = undefined
      for (const item of [...pending.values()]) if (item.ws === ws) item.reject()
    })
    ws.on('message', (data, binary) => {
      if (binary) { ws.close(1003); return }
      let event: unknown
      try { event = JSON.parse(data.toString()) } catch { ws.close(1007); return }
      if (object(event) && typeof event.echo === 'string' && pending.has(event.echo)) {
        const item = pending.get(event.echo)!
        if (item.ws === ws) { if (event.status === 'ok' && event.retcode === 0) item.resolve(); else item.reject() }
        return
      }
      const input = inbound(event, c)
      if (!input || closing || store.state.blocked || queued >= c.maxQueue) return
      queued++
      chain = chain.then(async () => {
        if (closing || store.state.blocked || active !== ws || ws.readyState !== WebSocket.OPEN) return
        if (!store.claim(input.key)) return
        store.state.inflight = true
        store.save()
        let reply: string
        try {
          reply = await stream(c, input.user, input.text, c.turnTimeoutMs)
          store.state.inflight = false
          store.save()
        } catch {
          store.block()
          try { await stream(c, input.user, 'stop', c.controlTimeoutMs, true) } catch {}
          try { await send(ws, input.user, '网关已安全封锁：任务需要人工交互或上游结果不确定，已请求停止。请在本机确认会话状态后人工恢复。') } catch {}
          return
        }
        if (reply) { try { await send(ws, input.user, reply) } catch { process.stderr.write('reply_delivery_unknown_no_retry\n') } }
      }).catch(() => {
        try { store.block() } catch {}
        closing = true
        ws.terminate()
        process.stderr.write('gateway_storage_failure\n')
      }).finally(() => { queued-- })
    })
  })
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(c.port, c.host, () => { server.removeListener('error', reject); resolve() }) }) }
  catch (error) { store.close(); throw error }
  return {
    server, store,
    async close() {
      closing = true
      for (const ws of wss.clients) ws.terminate()
      await chain
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  }
}
