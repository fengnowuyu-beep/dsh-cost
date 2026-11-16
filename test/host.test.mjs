/** dsh-cost Host half: the route family, the price table and the spend roll-up. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { close, deepEqual, equal, ok, run, test } from './harness.mjs'
import { apply, PLUGIN_VERSION, ROUTE_PREFIX } from '../lib/index.js'

/** A quiet logger that remembers what was said. */
function logger() {
  const lines = []
  const record = kind => (...args) => lines.push(`${kind}: ${args.join(' ')}`)
  return { lines, info: record('info'), warn: record('warn'), debug: record('debug'), error: record('error') }
}

/** One live Session stand-in holding exactly the events given. */
function session(events, id = 'session-live') {
  return {
    id,
    seq: events.length,
    snapshotEvents: (fromSeq = 0) => events.filter(event => event.seq >= fromSeq)
  }
}

/** An `assistant/message` event with provider usage. */
function assistantMessage(seq, usage, model = 'deepseek-flash', time = Date.parse('2026-10-09T02:00:00Z')) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: seq,
      step: 0,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model } },
      stream: [],
      usage
    }
  }
}

/** A `subagent/catalog` event: how a delegating session names what it spawned. */
function subagentCatalog(seq, childId, label = '') {
  return { type: 'subagent/catalog', seq, time: Date.parse('2026-10-09T02:00:00Z'), data: { version: 0, childId, mode: 'one-shot', label } }
}

/** A POST request shaped the way the handler consumes one. */
function request(method, body, options = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method: options.httpMethod ?? 'POST',
    url: `${ROUTE_PREFIX}/${method}`,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    headers: {
      host: options.host ?? '127.0.0.1:19387',
      ...options.headers ?? {}
    },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    }
  }
}

/** A response that captures what was written. */
function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    write(text) {
      this.body += String(text)
      return true
    },
    on() {},
    end(text) {
      this.body = this.body === '' ? (text ?? '') : this.body
    }
  }
}

/**
 * A `sessionPersistence` stand-in: stored logs addressed by session id.
 * @param logs - `Map` of session id to its events.
 */
function persistence(logs) {
  return {
    async open(id, access) {
      if (!logs.has(id)) throw new Error(`no such session: ${id}`)
      equal(access, 'read', 'pricing must never take write ownership of a stored session')
      return {
        header: { id },
        async read() {
          return { events: logs.get(id) }
        },
        async close() {}
      }
    }
  }
}

/** Build the plugin over a scratch home and return its captured route handler. */
async function harness(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cost-host-'))
  const log = logger()
  const routes = []
  const sessions = options.sessions ?? new Map()
  const fakeContext = {
    logger: log,
    effect(fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    get(name) {
      if (name === 'sessions') return { get: id => sessions.get(id) }
      return options.context?.[name]
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      }
    }
  }
  apply(fakeContext, { dshHome: home, ...options.config ?? {} })
  const route = routes.at(-1)
  return {
    home,
    log,
    route,
    async call(method, body, callOptions = {}) {
      const res = response()
      await route.handler(request(method, body, callOptions), res)
      let payload
      try {
        payload = JSON.parse(res.body)
      } catch {
        payload = undefined
      }
      return { status: res.status, payload, headers: res.headers, response: res }
    },
    async dispose() {
      // A background price refresh can still be writing `cost/prices.json` while
      // the scratch directory is removed; on Windows that race surfaces as
      // ENOTEMPTY, so the removal retries instead of failing the test.
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

test('the route family answers with the projection, under the cost state directory', async () => {
  const box = await harness()
  try {
    const res = await box.call('settings.get')
    equal(res.status, 200)
    equal(res.payload.ok, true)
    const settings = res.payload.settings
    equal(settings.pluginVersion, PLUGIN_VERSION)
    equal(settings.enabled, true)
    equal(settings.cost.currency, 'CNY')
    equal(settings.cost.includeSubagents, true)
    equal(settings.prices.source, 'builtin')
    equal(settings.prices.currency, 'CNY')
    ok(settings.settingsFile.includes('cost'), 'its own state directory, not the toolbox one')
    ok(settings.pricesFile.endsWith('prices.json'))
    equal(res.headers['cache-control'], 'no-store')
    // The status alias answers the same projection.
    const status = await box.call('status')
    equal(status.status, 200)
    equal(status.payload.settings.pluginVersion, PLUGIN_VERSION)
  } finally {
    await box.dispose()
  }
})

test('the fence refuses a non-loopback caller and a cross-site request', async () => {
  const box = await harness()
  try {
    const remote = await box.call('settings.get', undefined, { remoteAddress: '192.168.1.9' })
    equal(remote.status, 403)
    equal(remote.payload.error.code, 'forbidden')
    const crossSite = await box.call('cost.session', { sessionId: 'x' }, { headers: { 'sec-fetch-site': 'cross-site' } })
    equal(crossSite.status, 403)
    const foreignHost = await box.call('settings.get', undefined, { host: 'evil.example.com' })
    equal(foreignHost.status, 403)
    // The loopback caller reaches the switch, which is what proves the fence is
    // only a fence.
    const allowed = await box.call('cost.session', {})
    equal(allowed.status, 400, 'past the fence, the missing session id is a 400')
  } finally {
    await box.dispose()
  }
})

test('only POST is accepted, and only known methods', async () => {
  const box = await harness()
  try {
    const get = await box.call('settings.get', undefined, { httpMethod: 'GET' })
    equal(get.status, 405)
    equal(get.payload.error.code, 'method-error')
    const unknown = await box.call('nonsense')
    equal(unknown.status, 404)
    equal(unknown.payload.error.code, 'not-found')
  } finally {
    await box.dispose()
  }
})

test('a malformed body is answered with a clear error, not a crash', async () => {
  const box = await harness()
  try {
    const res = response()
    const broken = request('settings.get')
    broken[Symbol.asyncIterator] = async function * () {
      yield Buffer.from('{ not json', 'utf8')
    }
    await box.route.handler(broken, res)
    equal(res.status, 400)
    equal(JSON.parse(res.body).error.code, 'bad-json')
  } finally {
    await box.dispose()
  }
})

test('a settings update round-trips and normalises out-of-range values', async () => {
  const box = await harness()
  try {
    const res = await box.call('settings.update', {
      settings: {
        enabled: true,
        cost: { currency: 'EUR', usdCny: 9999, showInComposer: false, pricingSource: 'nonsense', includeSubagents: false }
      }
    })
    equal(res.status, 200)
    const cost = res.payload.settings.cost
    equal(cost.currency, 'CNY', 'an unknown currency falls back')
    equal(cost.usdCny, 7.1, 'an out-of-range rate falls back')
    equal(cost.showInComposer, false, 'a real change is kept')
    equal(cost.pricingSource, 'auto', 'an unknown source falls back')
    equal(cost.includeSubagents, false, 'and the subagent switch is kept')

    // The document is on disk, and a fresh mount reads it back.
    const again = await harness({ config: { dshHome: box.home } })
    try {
      const reread = await again.call('settings.get')
      equal(reread.payload.settings.cost.showInComposer, false)
    } finally {
      await again.dispose()
    }
  } finally {
    await box.dispose()
  }
})

test('the first run adopts the spend settings the combined plugin left behind', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cost-legacy-'))
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'toolbox'), { recursive: true })
    await writeFile(join(home, 'toolbox', 'settings.json'), JSON.stringify({
      sendKey: 'enter',
      cost: { currency: 'USD', usdCny: 7.3, pricingSource: 'builtin', refreshHours: 24 }
    }), 'utf8')
    await writeFile(join(home, 'toolbox', 'prices.json'), JSON.stringify({ version: 1, source: 'builtin', models: {} }), 'utf8')

    const log = logger()
    const routes = []
    apply({
      logger: log,
      effect: fn => (typeof fn() === 'function' ? () => {} : () => {}),
      get: () => undefined,
      webServer: { register: route => { routes.push(route); return () => {} } }
    }, { dshHome: home })
    const res = response()
    await routes.at(-1).handler(request('settings.get'), res)
    const settings = JSON.parse(res.body).settings
    equal(settings.cost.currency, 'USD', 'the user’s currency survived the split')
    equal(settings.cost.usdCny, 7.3)
    equal(settings.cost.refreshHours, 24)
    // And the price cache was copied into this plugin's own directory.
    const { existsSync } = await import('node:fs')
    ok(existsSync(join(home, 'cost', 'prices.json')), 'the cached price table moved too')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a conversation’s spend counts image money beside the token money', async () => {
  const events = [
    assistantMessage(0, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    {
      type: 'tool/call',
      seq: 1,
      time: Date.parse('2026-11-13T08:00:00Z'),
      data: { turn: 1, step: 1, callId: 'call-image', name: 'generate_image', arguments: JSON.stringify({ size: '1024x1024' }) }
    },
    {
      type: 'tool/result',
      seq: 2,
      time: Date.parse('2026-11-13T08:00:05Z'),
      data: {
        turn: 1,
        step: 1,
        toolCallId: 'call-image',
        message: { content: [{ type: 'text', text: 'Generated one image with openai-compat/MiniMax-H3-Image (1024x1024).' }] }
      }
    }
  ]
  const sessions = new Map([['session-media', session(events, 'session-media')]])
  const box = await harness({ sessions })
  try {
    const first = await box.call('cost.session', { sessionId: 'session-media' })
    equal(first.status, 200)
    const cost = first.payload.cost
    equal(cost.media.imageCount, 1)
    close(cost.mediaAmount, 0.1430, 1e-9)
    close(cost.totalAmount, cost.amount + 0.1430, 1e-9)
    equal(cost.includeMedia, true)
    equal(cost.hasUsage, true)

    // Switched off, the total drops back to the token money but the media
    // section still reports what was billed.
    await box.call('settings.update', { cost: { includeMedia: false } })
    const second = await box.call('cost.session', { sessionId: 'session-media' })
    equal(second.payload.cost.includeMedia, false)
    close(second.payload.cost.totalAmount, second.payload.cost.amount, 1e-9)
    equal(second.payload.cost.media.imageCount, 1)
  } finally {
    await box.dispose()
  }
})

test('the spend route prices a live session', async () => {
  const events = [
    assistantMessage(0, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })
  ]
  const sessions = new Map([['session-live', session(events)]])
  const box = await harness({ sessions })
  try {
    const live = await box.call('cost.session', { sessionId: 'session-live' })
    equal(live.status, 200)
    const cost = live.payload.cost
    // Peak hour (Friday 02:00 UTC), CNY: 1M miss 2 + 1M output 8.
    close(cost.amount, 10, 1e-9)
    equal(cost.currency, 'CNY')
    equal(cost.own.amount, cost.amount)
    equal(cost.childCount, 0)
    equal(cost.hasUsage, true)
    equal(cost.samples, 1)
    equal(cost.peakSamples, 1)
    equal(cost.priceSource, 'builtin')

    const missing = await box.call('cost.session', { sessionId: 'session-gone' })
    equal(missing.status, 404)
    equal(missing.payload.error.code, 'session-unknown')
    const absent = await box.call('cost.session', {})
    equal(absent.status, 400)
    equal(absent.payload.error.code, 'bad-session')
  } finally {
    await box.dispose()
  }
})

test('a conversation this process never loaded is priced from its stored log', async () => {
  const events = [
    assistantMessage(0, { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })
  ]
  const box = await harness({ context: { sessionPersistence: persistence(new Map([['session-old', events]])) } })
  try {
    const stored = await box.call('cost.session', { sessionId: 'session-old' })
    equal(stored.status, 200, 'a stored session is priced, not refused')
    close(stored.payload.cost.amount, 8, 1e-9)
    equal(stored.payload.cost.tokens, 1_000_000)
  } finally {
    await box.dispose()
  }
})

test('a conversation’s spend includes every subagent below it', async () => {
  const peak = [assistantMessage(0, { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })]
  const offPeakTime = Date.parse('2026-10-09T12:00:00Z')
  const offPeak = [
    assistantMessage(0, { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'deepseek-flash', offPeakTime)
  ]
  const logs = new Map([
    ['session-main', [...peak, subagentCatalog(1, 'session-child-a', '修登录'), subagentCatalog(2, 'session-child-b')]],
    ['session-child-a', [...offPeak, subagentCatalog(1, 'session-grandchild')]],
    ['session-child-b', offPeak],
    ['session-grandchild', offPeak]
  ])
  const box = await harness({
    context: {
      sessionPersistence: persistence(logs),
      sessionTitle: {
        async readTitleSnapshot() {
          return { title: { value: '自动生成的标题' } }
        }
      }
    }
  })
  try {
    const res = await box.call('cost.session', { sessionId: 'session-main' })
    const cost = res.payload.cost
    close(cost.own.amount, 8, 1e-9, 'the parent’s own spend is the peak-rate one')
    equal(cost.childCount, 3)
    close(cost.amount, 8 + 4 + 4 + 4, 1e-9, 'the total is the parent plus all of them')
    equal(cost.children[0].title, '修登录', 'the catalog label is the row title')
    equal(cost.children[1].title, '自动生成的标题', 'a child with no label falls back to its title service')
    equal(cost.children.at(-1).depth, 2, 'a subagent of a subagent is listed too')
    // The headline lines still add up to the headline amount.
    const summed = cost.lines.reduce((sum, line) => sum + line.amount, 0)
    close(summed, cost.amount, 1e-9)
  } finally {
    await box.dispose()
  }
})

test('the subagent roll-up is bounded, and can be switched off entirely', async () => {
  const events = [assistantMessage(0, { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })]
  const logs = new Map([['s0', [...events, subagentCatalog(1, 's1')]]])
  for (let level = 1; level <= 5; level += 1) {
    logs.set(`s${level}`, [...events, ...(level < 5 ? [subagentCatalog(1, `s${level + 1}`)] : [])])
  }
  const box = await harness({ context: { sessionPersistence: persistence(logs) } })
  try {
    const res = await box.call('cost.session', { sessionId: 's0' })
    const cost = res.payload.cost
    equal(cost.childCount, 3, 'three levels are priced, not five')
    equal(cost.subagentsTruncated, true, 'and the report says it stopped early')

    await box.call('settings.update', { settings: { enabled: true, cost: { includeSubagents: false } } })
    const off = await box.call('cost.session', { sessionId: 's0' })
    equal(off.payload.cost.childCount, 0, 'switched off, only the conversation itself is priced')
    close(off.payload.cost.amount, 8, 1e-9)
  } finally {
    await box.dispose()
  }
})

test('the price routes expose and refresh the table', async () => {
  const box = await harness()
  try {
    const got = await box.call('prices.get')
    equal(got.status, 200)
    equal(got.payload.prices.source, 'builtin')
    ok(Array.isArray(got.payload.prices.models) && got.payload.prices.models.length > 0)
    ok(got.payload.document !== undefined, 'the full document travels so the audit tool can use it')
    // With the builtin source selected, a refresh touches no network at all.
    await box.call('settings.update', { settings: { enabled: true, cost: { pricingSource: 'builtin' } } })
    const refreshed = await box.call('prices.refresh')
    equal(refreshed.status, 200)
    equal(refreshed.payload.error, '')
    equal(refreshed.payload.prices.source, 'builtin')
  } finally {
    await box.dispose()
  }
})

test('every copy key the client asks for is defined in both languages', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^[^\n]*?\/\/[^\n]*$/gmu, '')
  const used = new Set()
  const pattern = /\bt\(\s*'([^']+)'/gu
  let match = pattern.exec(source)
  while (match !== null) {
    used.add(match[1])
    match = pattern.exec(source)
  }
  ok(used.size > 20, `expected the client to use many keys, found ${String(used.size)}`)
  // The dictionaries live inside the browser bundle, which cannot be imported
  // here, so each block is sliced out of the source text and asked separately.
  const zhBlock = source.slice(source.indexOf('const zh = {'), source.indexOf('const en = {'))
  const enBlock = source.slice(source.indexOf('const en = {'))
  /** A dotted key is always quoted; a single word may be a bare identifier. */
  const defines = (block, key) => block.includes(`'${key}':`) || (!key.includes('.') && block.includes(`${key}:`))
  for (const key of used) {
    ok(zhBlock !== '', 'the zh dictionary must be findable')
    ok(defines(zhBlock, key), `the client asks for "${key}", which zh does not define`)
    ok(defines(enBlock, key), `the client asks for "${key}", which en does not define`)
  }
})

await run('host')
