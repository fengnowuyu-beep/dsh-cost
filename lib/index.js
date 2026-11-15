/**
 * dsh-cost — Host half.
 *
 * One job, split out of `dsh-toolbox` so the window/restart/tray work and the
 * money work can be enabled, disabled and updated independently:
 *
 *  - **Pricing.** A price table for the DeepSeek models, shipped with the plugin
 *    and refreshable from the vendor's own published table.
 *  - **Spend.** Per-conversation cost, folded from the Session log so it always
 *    describes the same tokens the composer's token pill shows, and rolled up
 *    over the subagent conversations that conversation delegated to.
 *
 * The browser half drives it through one POST-only route family; this half owns
 * every decision (which price applies, which sessions belong to a conversation)
 * so the two halves cannot disagree.
 *
 * @module dsh-cost
 */

import { readFileSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { combineReports, createCostLedger } from './cost.js'
import {
  builtinPriceDocument,
  isPriceDocumentStale,
  loadCachedPrices,
  normalizeExternalJson,
  normalizePriceDocument,
  refreshPrices,
  saveCachedPrices,
  BUILTIN_PRICES
} from './pricing.js'
import {
  composeSettings,
  loadPersisted,
  logsDir,
  migrateCachedPrices,
  normalizeSettings,
  pricesPath,
  publicSettings,
  resolveDshHome,
  savePersisted,
  settingsPath,
  stateDir
} from './settings.js'

/** Cordis services this Host half needs before it can mount its routes. */
export const inject = ['webServer']

/** The plugin's own root, used to read the manifest. */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The plugin's own version, surfaced to the settings page for support. Read from
 * the manifest instead of being duplicated, so the two cannot drift apart.
 */
export const PLUGIN_VERSION = readOwnVersion()

/** @returns the manifest version, or '0.0.0' when it cannot be read. */
function readOwnVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
    return typeof manifest?.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Route family mounted on the Host webserver. */
export const ROUTE_PREFIX = '/dsh-cost/api'

/** Route methods the browser half may call. */
const ROUTE_KEYS = Object.freeze([
  'settings.get',
  'settings.update',
  'prices.get',
  'prices.refresh',
  'cost.session',
  'status'
])

/** Bounded body size for these small JSON requests. */
const BODY_LIMIT = 256_000

/**
 * How far below the conversation the subagent roll-up walks.
 *
 * DSH gives every subagent its own session, and a teammate may spawn its own, so
 * the roll-up is recursive — but a spend readout must stay bounded: a deep tree
 * would read dozens of logs for one pill. Three levels covers the shapes this
 * plugin sees (agent team → teammate → its own subagent) and the reply says when
 * it stopped.
 */
const SUBAGENT_MAX_DEPTH = 3

/** At most this many subagent sessions are priced for one conversation. */
const SUBAGENT_MAX_NODES = 64

/** How many folded *stored* session reports are remembered (aggregates only). */
const STORED_REPORT_LIMIT = 192

/**
 * The subagent sessions one session's own log points at.
 *
 * DSH records a `subagent/catalog` event in the *delegating* session's log, so
 * this needs neither a lineage field on the child nor a scan of the whole store —
 * and it works identically for a live conversation and a stored one. (Verified
 * against the real store: 92 root sessions, 94 at depth 1 and 63 at depth 2, with
 * the catalog's `childId` as the only link between them.)
 *
 * @param events - the parent session's events.
 * @returns `{ id, label }` per child, in spawn order.
 */
function subagentChildren(events) {
  const seen = new Set()
  const children = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'subagent/catalog') continue
    const id = event.data?.childId
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    children.push({ id, label: typeof event.data?.label === 'string' ? event.data.label : '' })
  }
  return children
}

/** One HTTP-level failure carrying its status. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Write one JSON response. */
function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

/** Whether one address is loopback. */
function isLoopbackAddress(address) {
  const normalized = String(address).toLowerCase()
  if (normalized === '::1') return true
  const candidate = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
  const parts = candidate.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/** Whether one hostname names loopback. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  return isLoopbackAddress(hostname)
}

/**
 * Loopback-only request fence, mirroring the `/api` gateway's posture: a price
 * refresh (which makes outbound requests) must never be reachable from another
 * machine on the network.
 * @param request - the incoming request.
 * @returns whether the caller is this machine.
 */
function isTrusted(request) {
  const remote = request?.socket?.remoteAddress
  if (typeof remote === 'string' && !isLoopbackAddress(remote)) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** Read a JSON body with a hard size cap. */
async function readJsonBody(request, limit = BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'payload-too-large', 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad-json', 'request body is not valid JSON')
  }
}

/**
 * The live cost box. Exposed for the offline test suite; the Loader only needs
 * {@link apply}.
 */
export class CostBox {
  /**
   * @param options - resolved paths, logger and Loader config.
   */
  constructor(options) {
    this.logger = options.logger
    this.config = options.config ?? {}
    this.pluginRoot = options.pluginRoot
    this.dshHome = resolveDshHome(this.config.dshHome)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? (() => Date.now())

    // The split's first run adopts the spend settings (and the cached price
    // table) the combined plugin wrote, so nothing the user configured is lost.
    this.persisted = loadPersisted(this.logger, this.dshHome)
    this.settings = composeSettings(this.persisted, this.config)
    migrateCachedPrices(this.dshHome)

    /** Effective price document plus where it came from. */
    this.prices = { document: builtinPriceDocument(), error: '', attempts: [], fetchedAt: 0 }
    /** Spend memo, invalidated whenever the price document changes. */
    this.costs = createCostLedger({ limit: 48 })
    /**
     * Folded spends of *stored* sessions, keyed by log length and price stamp.
     * Only aggregates are kept — a conversation with dozens of subagents would
     * otherwise pin every one of their event arrays in memory.
     */
    this.storedReports = new Map()
    /** One price refresh at a time. */
    this.priceRefresh = undefined
  }

  /**
   * The projection the browser half reads: the effective settings, the price
   * table in force, and the live state of the memo.
   */
  describe() {
    const document = this.effectivePrices()
    return {
      ...publicSettings(this.settings, this.dshHome, {
        pluginVersion: PLUGIN_VERSION,
        platform: process.platform
      }),
      prices: {
        source: document.source,
        label: document.label,
        updatedAt: document.updatedAt,
        models: Object.keys(document.models),
        modelCount: Object.keys(document.models).length,
        currency: this.settings.cost.currency,
        stale: isPriceDocumentStale(document, this.settings.cost.refreshHours, this.now()),
        file: pricesPath(this.dshHome),
        error: this.prices.error,
        attempts: this.prices.attempts
      },
      costStats: { cachedSessions: this.costs.size }
    }
  }

  /** The price document in force: the cached fetch when there is one, else the shipped table. */
  effectivePrices() {
    if (this.settings.cost.pricingSource === 'builtin') return builtinPriceDocument()
    return this.prices.document ?? builtinPriceDocument()
  }

  /** Adopt a price document and drop every memo derived from the previous one. */
  adoptPrices(document, meta = {}) {
    this.prices = {
      document: document ?? builtinPriceDocument(),
      error: meta.error ?? '',
      attempts: meta.attempts ?? [],
      fetchedAt: meta.fetchedAt ?? this.now()
    }
    this.costs.invalidate()
    this.storedReports.clear()
  }

  /** Load a cached price document, preferring the shipped table when none is usable. */
  loadCached() {
    const cached = loadCachedPrices(this.dshHome, this.logger)
    if (cached !== null) {
      this.adoptPrices(cached)
      return true
    }
    this.adoptPrices(builtinPriceDocument())
    return false
  }

  /**
   * Refresh the price table.
   * @param options - whether the caller is waiting for the result.
   * @returns `{ document, error, attempts }`.
   */
  async refreshPrices(options = {}) {
    if (this.priceRefresh !== undefined) return this.priceRefresh
    const { pricingSource, pricingUrl, refreshHours } = this.settings.cost
    const source = pricingSource === 'builtin' ? 'builtin' : pricingSource
    this.priceRefresh = (async () => {
      try {
        const result = await refreshPrices({
          source: source === 'auto' ? 'auto' : source,
          pricingUrl,
          fetchImpl: this.fetchImpl,
          logger: this.logger,
          now: this.now
        })
        if (result.document !== null) {
          this.adoptPrices(result.document, { error: '', attempts: result.attempts, fetchedAt: this.now() })
          try {
            await saveCachedPrices(this.dshHome, result.document)
          } catch (error) {
            this.logger?.warn?.(`cost: could not cache prices: ${String(error)}`)
          }
        } else if (result.error !== '') {
          // A failed refresh keeps whatever is already in force — the shipped
          // table or the last successful fetch — and only reports the reason.
          this.prices = { ...this.prices, error: result.error, attempts: result.attempts }
          this.logger?.warn?.(`cost: price refresh failed: ${result.error}`)
        }
        void refreshHours
        void options
        return { document: this.effectivePrices(), error: this.prices.error, attempts: this.prices.attempts }
      } finally {
        this.priceRefresh = undefined
      }
    })()
    return this.priceRefresh
  }

  /** Merge a settings patch, persist it, and re-apply the parts that need it. */
  async update(patch) {
    const requested = patch !== null && typeof patch === 'object' ? patch : {}
    const merged = {}
    for (const key of Object.keys(this.settings)) {
      merged[key] = requested[key] !== undefined ? requested[key] : this.settings[key]
    }
    const next = normalizeSettings(merged)
    this.persisted = next
    await savePersisted(next, this.dshHome)
    const previousCurrency = this.settings.cost.currency
    const previousUsdCny = this.settings.cost.usdCny
    const previousSource = this.settings.cost.pricingSource
    const previousSubagents = this.settings.cost.includeSubagents
    this.settings = composeSettings(this.persisted, this.config)
    if (previousCurrency !== this.settings.cost.currency || previousUsdCny !== this.settings.cost.usdCny) {
      this.costs.invalidate()
      this.storedReports.clear()
    }
    if (previousSource !== this.settings.cost.pricingSource) {
      if (this.settings.cost.pricingSource === 'builtin') this.adoptPrices(builtinPriceDocument())
      else this.loadCached()
    }
    if (previousSubagents !== this.settings.cost.includeSubagents) this.storedReports.clear()
    return this.settings
  }

  /**
   * Price one conversation: its own tokens plus every subagent's below it.
   *
   * A stored session is read through `sessionPersistence` in read mode (which
   * never takes write ownership and works while another process is writing), so
   * pricing a conversation never resumes an agent.
   *
   * @param sessionId - the session to report on.
   * @returns the spend report, `own` plus a `children` breakdown.
   */
  async sessionCost(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId : ''
    if (id === '') throw new HttpError(400, 'bad-session', '缺少 sessionId')
    const document = this.effectivePrices()
    const context = {
      document,
      documentStamp: `${document.source}|${document.updatedAt}`,
      displayCurrency: this.settings.cost.currency,
      usdCny: this.settings.cost.usdCny
    }

    const opened = await this.openSession(id)
    if (opened === undefined) throw new HttpError(404, 'session-unknown', `找不到会话 ${id}`)
    const own = opened.stored === true ? this.priceStored(id, opened.events, context) : this.costs.compute(opened.session, context)

    const children = []
    const childReports = []
    const seen = new Set([id])
    const include = this.settings.cost.includeSubagents === true
    let queue = include ? [{ id, depth: 1, events: opened.events }] : []
    let truncated = false
    while (queue.length > 0) {
      const next = []
      for (const parent of queue) {
        if (parent.depth > SUBAGENT_MAX_DEPTH || children.length >= SUBAGENT_MAX_NODES) {
          truncated = true
          continue
        }
        for (const child of subagentChildren(parent.events)) {
          if (seen.has(child.id)) continue
          if (children.length >= SUBAGENT_MAX_NODES) {
            truncated = true
            continue
          }
          seen.add(child.id)
          const childOpened = await this.openSession(child.id)
          if (childOpened === undefined) continue
          const priced = childOpened.stored === true
            ? this.priceStored(child.id, childOpened.events, context)
            : this.costs.compute(childOpened.session, context)
          childReports.push(priced)
          children.push({
            sessionId: child.id,
            parentSession: parent.id,
            depth: parent.depth,
            // The catalog's own label is what the delegating agent called this
            // task, so it is a better row title than the child's generated one.
            title: child.label === '' ? await this.sessionTitleOf(child.id) : child.label,
            amount: priced.amount,
            tokens: priced.tokens,
            samples: priced.samples,
            hasUsage: priced.hasUsage,
            lines: priced.lines
          })
          next.push({ id: child.id, depth: parent.depth + 1, events: childOpened.events })
        }
      }
      queue = next
    }

    const total = combineReports([own, ...childReports])
    // The price a report was priced with travels with it, so the panel can say
    // which table produced the number instead of implying it is timeless.
    return {
      ...total,
      sessionId: id,
      own: {
        amount: own.amount,
        tokens: own.tokens,
        samples: own.samples,
        hasUsage: own.hasUsage,
        lines: own.lines,
        byModel: own.byModel
      },
      children,
      childCount: children.length,
      subagentsTruncated: truncated,
      currency: this.settings.cost.currency,
      otherCurrency: this.settings.cost.currency === 'USD' ? 'CNY' : 'USD',
      priceSource: document.source,
      priceLabel: document.label,
      priceUpdatedAt: document.updatedAt
    }
  }

  /**
   * One session's pricing handle and the events behind it.
   *
   * Live when this process has the session, read from storage otherwise — which
   * is the case that used to answer "不在本进程中" for every conversation the
   * process had not loaded.
   *
   * @param id - the session id.
   * @returns `{ session, events, stored }`, or undefined when the session is unknown.
   */
  async openSession(id) {
    const live = this.sessionsService()?.get?.(id)
    if (live !== undefined) {
      const events = typeof live.snapshotEvents === 'function' ? live.snapshotEvents(0) ?? [] : []
      return { session: live, events, stored: false }
    }
    const persistence = this.persistenceService()
    if (persistence === undefined) return undefined
    let handle
    let events = []
    try {
      handle = await persistence.open(id, 'read')
      const result = await handle.read()
      events = Array.isArray(result?.events) ? result.events : []
    } catch (error) {
      this.logger?.debug?.(`cost: stored session ${id} is unreadable: ${String(error)}`)
      return undefined
    } finally {
      try {
        await handle?.close?.()
      } catch {
        /* already closed */
      }
    }
    // A stored session gets a one-shot view: the fold reads the events once and
    // the array is then dropped. Memoising the *view* would keep every event of
    // every subagent alive, which for a conversation with dozens of them is
    // hundreds of megabytes.
    return {
      session: {
        id,
        seq: events.length,
        snapshotEvents: (from = 0) => events.filter(event => Number(event?.seq ?? 0) >= Number(from))
      },
      events,
      stored: true
    }
  }

  /**
   * Price one stored session, remembering only the folded report.
   *
   * The key is the log's length plus the price stamp: the same log can only fold
   * to the same number, and a log that grew folds again. Nothing but aggregates
   * is retained.
   *
   * @param id - the session id.
   * @param events - the stored events.
   * @param context - price document and currency context.
   * @returns the presented report.
   */
  priceStored(id, events, context) {
    const key = `${id}\u0000${events.length}\u0000${context.documentStamp}\u0000${context.displayCurrency}\u0000${context.usdCny}`
    const cached = this.storedReports.get(key)
    if (cached !== undefined) return cached
    const view = {
      id,
      seq: events.length,
      snapshotEvents: (from = 0) => events.filter(event => Number(event?.seq ?? 0) >= Number(from))
    }
    const report = this.costs.compute(view, context)
    this.storedReports.set(key, report)
    while (this.storedReports.size > STORED_REPORT_LIMIT) {
      const oldest = this.storedReports.keys().next()
      if (oldest.done === true) break
      this.storedReports.delete(oldest.value)
    }
    return report
  }

  /**
   * A subagent session's title, when the title service can answer.
   * @param sessionId - the child session id.
   * @returns the title, or '' when there is none.
   */
  async sessionTitleOf(sessionId) {
    let titles
    try {
      titles = this.ctx?.get?.('sessionTitle')
    } catch {
      return ''
    }
    if (titles === undefined || titles === null || typeof titles.readTitleSnapshot !== 'function') return ''
    try {
      const observation = await titles.readTitleSnapshot(sessionId)
      const value = observation?.title?.value ?? observation?.title ?? observation?.value
      return typeof value === 'string' ? value : ''
    } catch {
      return ''
    }
  }

  /** The persisted-session service, when this composition mounts one. */
  persistenceService() {
    try {
      return this.ctx?.get?.('sessionPersistence')
    } catch {
      return undefined
    }
  }

  /** The sessions service, when this composition mounts one. */
  sessionsService() {
    try {
      return this.ctx?.get?.('sessions')
    } catch {
      return undefined
    }
  }

  /** Append one line to the plugin's own audit log. */
  async audit(entry) {
    try {
      const file = join(logsDir(this.dshHome), 'cost.log')
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry })}\n`, 'utf8')
    } catch {
      /* auditing never fails a request */
    }
  }

  /** Wire the background jobs. */
  start() {
    const hadCache = this.loadCached()

    // The vendor table is fetched in the background on first start and whenever
    // the cached copy has aged out, so the shipped table is a starting point
    // rather than the answer. A stale fetch keeps whatever is already in force.
    if (this.settings.cost.autoRefreshPrices && this.settings.cost.pricingSource !== 'builtin') {
      const current = this.prices.document ?? builtinPriceDocument()
      const stale = !hadCache || isPriceDocumentStale(current, this.settings.cost.refreshHours, this.now())
      if (stale) {
        void this.refreshPrices({ background: true }).catch(error => {
          this.logger?.warn?.(`cost: background price refresh failed: ${String(error)}`)
        })
      }
    }
  }

  /** Release every owned resource. */
  dispose() {
    this.costs.invalidate()
    this.storedReports.clear()
  }
}

/**
 * Mount the Host half.
 * @param ctx - the Cordis host context (provides `webServer`).
 * @param config - optional Loader config (`enabled`, `dshHome`, defaults).
 */
export function apply(ctx, config) {
  if (config?.enabled === false) {
    ctx.logger?.info?.('cost: disabled by config')
    return
  }

  const logger = ctx.logger ?? console
  const box = new CostBox({ logger, config, pluginRoot: PLUGIN_ROOT })
  box.ctx = ctx

  ctx.effect(() => () => box.dispose(), 'cost: resources')
  ctx.effect(() => {
    box.start()
  }, 'cost: background jobs')

  // A background refresh on the configured cadence, so a long-running DSH keeps
  // a current table without the settings page being opened.
  ctx.effect(() => {
    const hours = box.settings.cost.refreshHours
    if (box.settings.cost.autoRefreshPrices !== true || box.settings.cost.pricingSource === 'builtin') return () => {}
    if (!Number.isFinite(hours) || hours <= 0) return () => {}
    const timer = setInterval(() => {
      const document = box.effectivePrices()
      if (isPriceDocumentStale(document, hours, box.now())) {
        void box.refreshPrices({ background: true }).catch(() => {})
      }
    }, Math.max(300_000, hours * 3600_000 / 4))
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'cost: price cadence')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!isTrusted(request)) {
        writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${ROUTE_PREFIX}/`)
        ? pathname.slice(ROUTE_PREFIX.length + 1)
        : undefined

      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      if (method === undefined || !ROUTE_KEYS.includes(method)) {
        writeJson(response, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${String(method)}"` } })
        return
      }

      try {
        const payload = await readJsonBody(request)
        switch (method) {
          case 'settings.get':
          case 'status':
            writeJson(response, 200, { ok: true, settings: box.describe() })
            return
          case 'settings.update': {
            await box.update(payload?.settings ?? payload)
            writeJson(response, 200, { ok: true, settings: box.describe() })
            return
          }
          case 'prices.get':
            writeJson(response, 200, { ok: true, prices: box.describe().prices, document: box.effectivePrices() })
            return
          case 'prices.refresh': {
            const result = await box.refreshPrices({ manual: true })
            void box.audit({ event: 'prices-refresh', ok: result.error === '', error: result.error ?? '' })
            writeJson(response, 200, {
              ok: true,
              prices: box.describe().prices,
              document: result.document ?? box.effectivePrices(),
              error: result.error ?? ''
            })
            return
          }
          case 'cost.session': {
            // A refused lookup is recorded with the session id the page actually
            // sent: an empty id and a stale id look identical from the browser,
            // and the browser is where the pill has to explain itself.
            try {
              const cost = await box.sessionCost(payload?.sessionId)
              writeJson(response, 200, { ok: true, cost })
            } catch (error) {
              void box.audit({
                event: 'cost',
                ok: false,
                sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : null,
                received: payload === undefined || payload === null ? null : Object.keys(payload),
                error: String(error?.message ?? error)
              })
              throw error
            }
            return
          }
          default:
            writeJson(response, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
        }
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        const code = error instanceof HttpError ? error.code : 'internal-error'
        const message = error instanceof Error ? error.message : String(error)
        if (status >= 500) logger.warn?.(`cost: ${method} failed: ${message}`)
        writeJson(response, status, { ok: false, error: { code, message } })
      }
    }
  }), 'cost: routes')

  logger.info?.(`cost: mounted ${ROUTE_PREFIX} (state: ${stateDir(box.dshHome)})`)
}

/**
 * A closed-over inspector for `dsh-tool-cordis` and the offline test suite: it
 * is deliberately side-effect free — no route, no timer.
 * @param ctx - any context of the app.
 * @returns the inspectable projection.
 */
export const inspector = (ctx) => {
  const box = new CostBox({ logger: ctx?.logger ?? console, config: {}, pluginRoot: PLUGIN_ROOT })
  return {
    version: PLUGIN_VERSION,
    stateDir: stateDir(box.dshHome),
    settingsFile: settingsPath(box.dshHome),
    pricesFile: pricesPath(box.dshHome),
    describe: () => box.describe(),
    refreshPrices: () => box.refreshPrices({ manual: true }),
    sessionCost: sessionId => box.sessionCost(sessionId),
    normalizeExternalJson,
    normalizePriceDocument,
    builtin: BUILTIN_PRICES
  }
}
