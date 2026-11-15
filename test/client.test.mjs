/**
 * Browser half: the module loads in a DOM-shaped sandbox, its registrations land
 * where they should, and the spend pill renders what the Host reported — including
 * the case the pill exists to prevent: a silent disappearance when pricing fails.
 *
 * Real React is replaced by a tiny renderer that keeps `type`/`props`, plus a hook
 * runtime that carries state across renders, so a component that decides on its
 * *second* render (which the pill does) can be observed at all.
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { deepEqual, equal, ok, run, test } from './harness.mjs'

// ── the sandbox ─────────────────────────────────────────────────────────────

const fakeDocument = {
  addEventListener() {},
  removeEventListener() {},
  createElement() {
    return { dataset: {}, style: {}, append() {}, remove() {} }
  },
  body: { append() {}, dataset: {} },
  querySelector() { return null },
  querySelectorAll() { return [] }
}

/** A minimal element factory; see the file header for why only props matter. */
function createElement(type, props, ...children) {
  return {
    type,
    props: {
      ...(props ?? {}),
      ...(children.length === 0 ? {} : children.length === 1 ? { children: children[0] } : { children })
    }
  }
}

// ── a hook runtime ──────────────────────────────────────────────────────────

let hookSlots = []
let hookCursor = 0

const hooks = {
  useState(initial) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = typeof initial === 'function' ? initial() : initial
    return [hookSlots[index], (next) => {
      hookSlots[index] = typeof next === 'function' ? next(hookSlots[index]) : next
    }]
  },
  useRef(value) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = { current: value }
    return hookSlots[index]
  },
  useEffect(fn) {
    const index = hookCursor++
    const previous = hookSlots[index]
    if (typeof previous === 'function') previous()
    hookSlots[index] = fn()
  },
  useCallback(fn) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = fn
    return hookSlots[index]
  },
  useMemo(fn) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = fn()
    return hookSlots[index]
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    hookCursor++
    return getSnapshot()
  }
}

/** Render one component, resuming hooks from the previous render. */
function renderComponent(component, props) {
  hookCursor = 0
  return component(props)
}

/** Forget hook state so the next render is a fresh mount. */
function resetHooks() {
  hookSlots = []
  hookCursor = 0
}

/** Depth-first walk of a rendered tree. */
function walkTree(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit)
    return
  }
  if (node.props === undefined) return
  visit(node)
  walkTree(node.props.children, visit)
}

/** Every string reachable in a rendered tree. */
function treeText(node) {
  const parts = []
  walkTree(node, (element) => {
    for (const value of Object.values(element.props)) {
      if (typeof value === 'string') parts.push(value)
    }
  })
  return parts.join(' ')
}

/** Every `title` attribute in a rendered tree. */
function treeTitles(node) {
  const titles = []
  walkTree(node, (element) => {
    if (typeof element.props.title === 'string') titles.push(element.props.title)
  })
  return titles
}

const reactShim = {
  default: {
    createElement,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
    useSyncExternalStore: hooks.useSyncExternalStore
  }
}

const context = {
  console: { log() {}, warn() {}, error() {}, info() {} },
  setTimeout,
  clearTimeout,
  location: { origin: 'http://127.0.0.1:19387', href: 'http://127.0.0.1:19387/#/s/x', port: '19387' },
  window: {
    __ModuleLoader__: { load: definition => { context.__definition = definition } },
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {}
  },
  document: fakeDocument,
  navigator: {},
  fetch: async () => { throw new Error('no network in tests') },
  require: (id) => {
    if (id === 'react') return reactShim
    if (id === 'react-dom') return { createPortal: () => null }
    throw new Error(`unexpected require("${id}")`)
  }
}
context.globalThis = context
vm.createContext(context)

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInContext(source, context, { filename: 'lib/client.js' })

const definition = context.__definition
ok(definition !== undefined, 'the module must register itself with the loader')
equal(definition.id, 'dsh-cost')
const exports = definition.factory(context.require)
const internals = exports.__internals
const t = key => internals.zh[key] ?? key

// ── the module contract ─────────────────────────────────────────────────────

test('the browser half declares the services it needs and mounts its two seats', () => {
  equal(exports.NS, 'cost')
  deepEqual(exports.inject, ['slots', 'locale'])
  const registrations = []
  const effects = []
  const ctx = {
    locale: {
      bind: _ns => key => key,
      register: (ns, dictionaries) => {
        registrations.push({ ns, dictionaries })
        return () => {}
      }
    },
    slots: {
      inject: (name, run) => {
        run()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      }
    },
    effect: (fn) => {
      const disposer = fn()
      effects.push(typeof disposer === 'function')
      return () => {}
    }
  }
  exports.apply(ctx)
  const dict = registrations.find(entry => entry.ns === 'cost')
  ok(dict !== undefined, 'the dictionaries must be registered')
  const seats = registrations.filter(entry => entry.options !== undefined).map(entry => entry.options)
  deepEqual(seats.map(seat => seat.name), ['conversation.composer.dock', 'settings.section'])
  equal(seats[0].id, 'cost.pill')
  equal(seats[1].id, 'dsh-cost')
  equal(seats[0].locale, 'cost')
  ok(effects.every(Boolean), 'every effect must return a disposer')
})

test('both dictionaries define the same keys', () => {
  const zh = Object.keys(internals.zh).sort()
  const en = Object.keys(internals.en).sort()
  deepEqual(zh, en)
  ok(zh.length > 25, `expected a complete dictionary, found ${String(zh.length)} keys`)
})

// ── the pill ────────────────────────────────────────────────────────────────

/** A priced report, with the parts a real one always carries. */
function pricedReport(overrides = {}) {
  return {
    sessionId: 'session-render',
    samples: 12,
    peakSamples: 4,
    buckets: { uncachedInputTokens: 120000, cacheReadTokens: 9000000, cacheWriteTokens: 0, outputTokens: 45000 },
    tokens: 9165000,
    amount: 1.876543,
    pricedTokens: 9165000,
    unpricedTokens: 0,
    unpricedModels: [],
    lines: [
      { kind: 'cacheHit', tokens: 9000000, amount: 0.18, unpricedTokens: 0 },
      { kind: 'cacheMiss', tokens: 120000, amount: 0.12, unpricedTokens: 0 },
      { kind: 'cacheWrite', tokens: 0, amount: 0, unpricedTokens: 0 },
      { kind: 'output', tokens: 45000, amount: 1.576543, unpricedTokens: 0 }
    ],
    byModel: [{ provider: 'deepseek', model: 'deepseek-flash', buckets: {}, tokens: 9165000, amount: 1.876543, unpricedTokens: 0, peakSamples: 4 }],
    hasUsage: true,
    currency: 'CNY',
    priceSource: 'builtin',
    priceLabel: 'DeepSeek 官方标价（随插件附带）',
    priceUpdatedAt: '2026-10-08T00:00:00.000Z',
    childCount: 0,
    own: { amount: 1.876543, tokens: 9165000, samples: 12, hasUsage: true, lines: [], byModel: [] },
    children: [],
    ...overrides
  }
}

/** Render the pill against a stubbed cost route and return the settled tree. */
async function renderPill({ report, status = 200, error = null, snapshot } = {}) {
  const originalFetch = context.fetch
  const requests = []
  context.fetch = async (url, options) => {
    requests.push({ url, body: options?.body })
    return {
      ok: status === 200,
      status,
      json: async () => (error === null ? { ok: true, cost: report } : { ok: false, error: { code: 'x', message: error } })
    }
  }
  try {
    internals.engine.store.patch({
      loaded: true,
      snapshot: snapshot ?? { enabled: true, cost: { currency: 'CNY', showInComposer: true } }
    })
    internals.engine.costCache.clear()
    resetHooks()
    const props = {
      t,
      sessionId: 'session-render',
      useProjection: () => ({ uncachedInputTokens: 120000, cacheReadTokens: 9000000, cacheWriteTokens: 0, outputTokens: 45000 })
    }
    const mounting = renderComponent(internals.CostPill, props)
    // The effect issued the request; let it settle, then render again.
    await new Promise(resolve => setTimeout(resolve, 0))
    const settled = renderComponent(internals.CostPill, props)
    return { mounting, settled, requests }
  } finally {
    context.fetch = originalFetch
    internals.engine.store.patch({ loaded: false, snapshot: null })
    resetHooks()
  }
}

test('the pill renders the amount and every billing line once priced', async () => {
  const { mounting, settled, requests } = await renderPill({ report: pricedReport() })
  equal(mounting, null, 'nothing is shown before the first answer arrives')
  ok(settled !== null, 'the pill must appear once a priced report arrives — it used to vanish here')
  equal(requests.length, 1)
  ok(String(requests[0].url).endsWith('/dsh-cost/api/cost.session'), 'it must ask this plugin’s own route')
  equal(JSON.parse(requests[0].body).sessionId, 'session-render')

  const text = treeText(settled)
  ok(text.includes(internals.formatMoney(1.876543, 'CNY')), `the amount must be rendered (got: ${text})`)
  for (const kind of ['cacheHit', 'cacheMiss', 'output']) {
    ok(text.includes(internals.costKindLabel(kind, t)), `the ${kind} line must be rendered`)
  }
  ok(text.includes(internals.formatMoney(0.18, 'CNY')), 'the cache-hit amount must be rendered')
  ok(!text.includes(internals.costKindLabel('cacheWrite', t)), 'a zero line must be omitted')
  ok(text.includes('99.6%') || text.includes('98.7%'), 'the cache hit rate must be rendered')
})

test('a pricing failure is visible, not a disappearing pill', async () => {
  const { settled } = await renderPill({ report: null, status: 404, error: '找不到会话 session-render' })
  ok(settled !== null, 'a failure must still render')
  const text = treeText(settled)
  ok(text.includes(t('cost.unavailable')), `the pill must say it is unavailable (got: ${text})`)
  const titles = treeTitles(settled).join(' ')
  ok(titles.includes('找不到会话 session-render'), 'and the tooltip must carry the reason')
})

test('the panel splits the total between the conversation and its subagents', async () => {
  const { settled } = await renderPill({
    report: pricedReport({
      amount: 3.5,
      own: { amount: 1.5, tokens: 4000000, samples: 2, hasUsage: true, lines: [], byModel: [] },
      childCount: 2,
      children: [
        { sessionId: 'session-abcdef123456', parentSession: 'session-render', depth: 1, title: '修登录', amount: 1.4, tokens: 3000000, samples: 3, hasUsage: true, lines: [] },
        { sessionId: 'session-ffffffffffff', parentSession: 'session-abcdef123456', depth: 2, title: '', amount: 0.6, tokens: 1000000, samples: 1, hasUsage: true, lines: [] }
      ]
    })
  })
  const text = treeText(settled)
  ok(text.includes(t('cost.subagentBreakdown')), `the breakdown heading must be rendered (got: ${text})`)
  ok(text.includes(t('cost.mainConversation')))
  ok(text.includes(internals.formatMoney(1.5, 'CNY')))
  ok(text.includes('修登录'), 'a named subagent is listed by its title')
  ok(text.includes('session-'), 'an unnamed one falls back to its (shortened) id')
  ok(text.includes(internals.formatMoney(1.4, 'CNY')) && text.includes(internals.formatMoney(0.6, 'CNY')))
  ok(text.includes(t('cost.subagentTotal')))
})

test('the pill obeys both switches and the display currency', async () => {
  const off = await renderPill({ report: pricedReport(), snapshot: { enabled: false, cost: { currency: 'CNY', showInComposer: true } } })
  equal(off.settled, null, 'the enabled switch must hide it')
  const notInComposer = await renderPill({ report: pricedReport(), snapshot: { enabled: true, cost: { currency: 'CNY', showInComposer: false } } })
  equal(notInComposer.settled, null, 'the in-composer switch must hide it')
  const usd = await renderPill({ report: pricedReport({ currency: 'USD' }), snapshot: { enabled: true, cost: { currency: 'USD', showInComposer: true } } })
  ok(treeText(usd.settled).includes(internals.formatMoney(1.876543, 'USD')), 'and it must render the configured currency')
})

test('the same session and token watermark is only priced once', async () => {
  const first = await renderPill({ report: pricedReport() })
  equal(first.requests.length, 1)
  // A second render with the same watermark must reuse the cached answer.
  const originalFetch = context.fetch
  let calls = 0
  context.fetch = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => ({ ok: true, cost: pricedReport() }) }
  }
  try {
    internals.engine.store.patch({ loaded: true, snapshot: { enabled: true, cost: { currency: 'CNY', showInComposer: true } } })
    resetHooks()
    const props = { t, sessionId: 'session-render', useProjection: () => ({ uncachedInputTokens: 120000, cacheReadTokens: 9000000, cacheWriteTokens: 0, outputTokens: 45000 }) }
    renderComponent(internals.CostPill, props)
    await new Promise(resolve => setTimeout(resolve, 0))
    equal(calls, 0, 'a memo hit must not reach the Host')
  } finally {
    context.fetch = originalFetch
    internals.engine.store.patch({ loaded: false, snapshot: null })
    resetHooks()
  }
})

// ── the panel position ─────────────────────────────────────────────────────

test('the panel opens toward the room that exists', () => {
  const viewport = { width: 1000, height: 800 }
  // The pill sits against the bottom edge: there is no room below.
  const bottom = internals.computePanelPosition({ top: 760, bottom: 780, right: 700 }, viewport)
  equal(bottom.side, 'above')
  equal(bottom.bottom, 800 - 760 + 6)
  equal(bottom.maxHeight >= 120, true)
  // Pinned to the top, the only room is below.
  const top = internals.computePanelPosition({ top: 0, bottom: 18, right: 200 }, viewport)
  equal(top.side, 'below')
  equal(top.top, 24)
  // A tall window gives the ideal height, a short one is capped by the room.
  const roomy = internals.computePanelPosition({ top: 700, bottom: 720, right: 300 }, viewport)
  equal(roomy.maxHeight, 300)
  const cramped = internals.computePanelPosition({ top: 160, bottom: 180, right: 300 }, viewport)
  equal(cramped.maxHeight <= 300, true)
  equal(cramped.maxHeight >= 120, true)
  // Never further right than the window.
  equal(top.right >= 8, true)
})

// ── the settings page ──────────────────────────────────────────────────────

test('the settings page renders the money controls and saves a whole draft', async () => {
  const originalFetch = context.fetch
  const updates = []
  context.fetch = async (url, options) => {
    const body = JSON.parse(options?.body ?? '{}')
    if (String(url).endsWith('settings.update')) {
      updates.push(body)
      return { ok: true, status: 200, json: async () => ({ ok: true, settings: { ...snapshot, ...body.settings } }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, settings: snapshot }) }
  }
  const snapshot = {
    enabled: true,
    pluginVersion: '1.0.0',
    settingsFile: 'C:\\x\\settings.json',
    pricesFile: 'C:\\x\\prices.json',
    stateDir: 'C:\\x',
    cost: { currency: 'CNY', usdCny: 7.1, showInComposer: true, pricingSource: 'auto', pricingUrl: '', autoRefreshPrices: true, refreshHours: 168, includeSubagents: true },
    prices: { source: 'builtin', label: '内置价目表', updatedAt: '2026-10-08T00:00:00.000Z', models: ['deepseek-flash'], stale: false, error: '' }
  }
  try {
    internals.engine.store.patch({ loaded: true, snapshot })
    resetHooks()
    const first = renderComponent(internals.CostSettings, { t })
    const text = treeText(first)
    ok(text.includes(t('cost.section')), 'the spend section must be there')
    ok(text.includes(t('cost.includeSubagents')), 'including the subagent switch')
    ok(text.includes('deepseek-flash'), 'and the priced models of the current table')
    await new Promise(resolve => setTimeout(resolve, 0))
    // Clicking save persists the whole draft through this plugin's route.
    const tree = first
    let saved = false
    walkTree(tree, (element) => {
      if (saved || element.type !== 'button' || element.props.disabled === true) return
      if (typeof element.props.onClick === 'function' && JSON.stringify(element.props.children).includes(t('save'))) {
        saved = true
        element.props.onClick()
      }
    })
    ok(saved, 'the save button must exist')
    await new Promise(resolve => setTimeout(resolve, 0))
    equal(updates.length, 1, 'and it must call settings.update once')
    equal(updates[0].settings.cost.currency, 'CNY')
  } finally {
    context.fetch = originalFetch
    internals.engine.store.patch({ loaded: false, snapshot: null })
    resetHooks()
  }
})

test('the settings page shows the read failure instead of an empty form', () => {
  internals.engine.store.patch({ loaded: true, error: '宿主路由不可达', snapshot: null })
  resetHooks()
  const tree = renderComponent(internals.CostSettings, { t })
  ok(treeText(tree).includes('宿主路由不可达'), 'the reason must be visible')
  internals.engine.store.patch({ loaded: false, snapshot: null })
})

await run('client')
