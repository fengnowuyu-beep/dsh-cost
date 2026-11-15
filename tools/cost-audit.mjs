/**
 * Price real session logs, offline, the way the plugin's cost routes do.
 *
 * Read-only by construction: it decodes one conversation from
 * `~/.dsh/sessions`, follows the `subagent/catalog` records that conversation
 * wrote, and prints what the Host would answer — so the stored-session path and
 * the subagent roll-up can be checked against the conversations that actually
 * exist on this machine, without a DSH restart.
 *
 *     node tools/cost-audit.mjs                     # the most recently written conversation
 *     node tools/cost-audit.mjs --port=9845          # ask a Host on another port for its table
 *     node tools/cost-audit.mjs <sessionId>         # a named conversation
 *     node tools/cost-audit.mjs <sessionId> --all   # list every subagent row
 *
 * Two checks matter, and it prints both:
 *
 *   1. a session priced through the ledger must equal the same session folded in
 *      one pass (the reference the pill has been showing all along);
 *   2. the conversation total must equal the parent plus every subagent below it.
 *
 * **Laziness is a requirement, not an optimisation.** An earlier version decoded
 * every log in the store to build a parent map and ran out of memory on a machine
 * with a few hundred sessions: a session's lineage is already in its own log, so
 * only the conversation asked about (and its children, bounded) is ever decoded.
 *
 * The price table is taken from the running Host when one is reachable
 * (`POST /dsh-cost/api/prices.get`), so the numbers here are the numbers the pill
 * shows; otherwise the shipped table is used.
 *
 * Session logs are *concatenated* zstd frames — one per append — and
 * `zstdDecompressSync` stops after the first, so frames are found by magic and
 * decoded one at a time.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { combineReports, createCostLedger, foldCost, presentCost } from '../lib/cost.js'
import { builtinPriceDocument } from '../lib/pricing.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** How many subagent levels the audit walks, matching the Host's own bound. */
const MAX_DEPTH = 3

/** How many subagent sessions are priced, matching the Host's own bound. */
const MAX_NODES = 64

/**
 * The price table to use: the running Host's, so these numbers are the numbers
 * the pill shows; the shipped table otherwise.
 * @returns a price document.
 */
async function priceDocument() {
  // The GUI port is not fixed, so it can be named: --port=9845, or DSH_PORT.
  const named = process.argv.find(argument => argument.startsWith('--port='))
  const port = named === undefined ? (process.env.DSH_PORT ?? '19387') : named.slice('--port='.length)
  for (const origin of [`http://127.0.0.1:${port}`]) {
    for (const route of ['/dsh-cost/api/prices.get', '/dsh-toolbox/api/prices.get']) {
      try {
        const response = await fetch(`${origin}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        })
        const payload = await response.json()
        // The route answers `{ ok, prices, document }`: the full document is
        // beside the projection, not inside it.
        const document = payload?.document ?? payload?.prices?.document
        if (document !== undefined && document !== null) {
          console.log(`price table: the running Host's (${document.source})`)
          return document
        }
      } catch {
        /* this origin or route is not there; keep looking */
      }
    }
  }
  console.log('price table: shipped builtin (no Host answered)')
  return builtinPriceDocument()
}

/** Every `session.v4.jsonl.zstd` under the harness home, with its size. */
function findLogs(root) {
  const found = []
  const walk = directory => {
    let entries = []
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') {
        try {
          found.push({ path, size: statSync(path).size, mtime: statSync(path).mtimeMs })
        } catch {
          /* vanished while walking */
        }
      }
    }
  }
  walk(root)
  return found
}

/** The byte offsets of every zstd frame in one buffer. */
function frameOffsets(buffer) {
  const offsets = []
  let index = buffer.indexOf(ZSTD_MAGIC)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(ZSTD_MAGIC, index + 4)
  }
  return offsets
}

/**
 * Decode the first frame of a log only — enough to read its header cheaply.
 * @param path - the log path.
 * @returns the first line of the log, or ''.
 */
function firstLine(path) {
  try {
    const buffer = readFileSync(path)
    const offsets = frameOffsets(buffer)
    if (offsets.length === 0) return ''
    const text = zstdDecompressSync(buffer.subarray(offsets[0], offsets[1] ?? buffer.length)).toString('utf8')
    return text.split('\n').find(line => line.trim() !== '') ?? ''
  } catch {
    return ''
  }
}

/** Decode every frame of one log into its events. */
function readEvents(path) {
  const buffer = readFileSync(path)
  const offsets = frameOffsets(buffer)
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offsets[index], offsets[index + 1] ?? buffer.length)))
    } catch {
      /* a torn tail is normal: the writer truncates it on the next append */
    }
  }
  const events = []
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (record?.type === 'session') continue
    if (record?.type !== undefined) events.push(record)
  }
  return events
}

/**
 * The subagent sessions one log points at — the same record the Host reads.
 * @param events - the parent's events.
 * @returns `{ id, label }` per child.
 */
function subagentChildren(events) {
  const seen = new Set()
  const children = []
  for (const event of events) {
    if (event?.type !== 'subagent/catalog') continue
    const id = event.data?.childId
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    children.push({ id, label: typeof event.data?.label === 'string' ? event.data.label : '' })
  }
  return children
}

/** Index session ids to log paths, decoding only each log's first frame. */
function indexSessions(root) {
  const index = new Map()
  for (const entry of findLogs(root)) {
    const line = firstLine(entry.path)
    let header
    try {
      header = JSON.parse(line)
    } catch {
      header = undefined
    }
    const id = typeof header?.id === 'string' && header.id !== ''
      ? header.id
      : entry.path.split(/[\\/]/u).at(-2)
    index.set(id, { ...entry, header })
  }
  return index
}

const root = join(homedir(), '.dsh', 'sessions')
const index = indexSessions(root)
if (index.size === 0) {
  console.log(`no session logs under ${root}`)
  process.exit(0)
}

// The session id is the first argument that is not a flag.
const wanted = process.argv.slice(2).find(argument => !argument.startsWith('--'))
const showAll = process.argv.includes('--all')
const target = wanted ?? [...index.entries()].sort((left, right) => right[1].mtime - left[1].mtime)[0][0]
if (!index.has(target)) {
  console.log(`no such session in the store: ${target}`)
  console.log(`known (newest first): ${[...index.entries()].sort((left, right) => right[1].mtime - left[1].mtime).slice(0, 8).map(([id]) => id).join(', ')}`)
  process.exit(1)
}

const document = await priceDocument()
const context = {
  document,
  documentStamp: `${document.source}|${document.updatedAt}`,
  displayCurrency: 'CNY',
  usdCny: 7.1
}
const money = value => `¥${Number(value).toFixed(4)}`

/** Price one conversation's events through the ledger, then free them. */
function price(events, id) {
  const view = {
    id,
    seq: events.length,
    snapshotEvents: from => events.filter(event => Number(event?.seq ?? 0) >= Number(from))
  }
  return createCostLedger({ limit: 4 }).compute(view, context)
}

/** The reference fold: the same events, folded in one pass. */
function priceDirect(events, id) {
  return presentCost(foldCost(events, { ...context, state: undefined }), { sessionId: id })
}

const ownEvents = readEvents(index.get(target).path)
const own = price(ownEvents, target)
const direct = priceDirect(ownEvents, target)
console.log(`conversation: ${target}`)
console.log(`  stored log:  ${index.get(target).path}`)
console.log(`  events:      ${ownEvents.length}`)
console.log(`  own amount:  ${money(own.amount)}  (${own.tokens} tokens, ${own.samples} samples)`)
console.log(`  reference:   ${money(direct.amount)}  (folded in one pass)`)
console.log(`  equal:       ${Math.abs(own.amount - direct.amount) < 1e-9 ? 'yes' : 'NO — the two paths disagree'}`)

// Walk the lineage the conversation itself recorded, bounded like the Host.
const rows = []
const reports = [own]
const seen = new Set([target])
let queue = [{ id: target, depth: 1, events: ownEvents }]
let truncated = false
while (queue.length > 0) {
  const next = []
  for (const parent of queue) {
    if (parent.depth > MAX_DEPTH || rows.length >= MAX_NODES) {
      truncated = true
      continue
    }
    for (const child of subagentChildren(parent.events)) {
      if (seen.has(child.id)) continue
      if (rows.length >= MAX_NODES) {
        truncated = true
        continue
      }
      seen.add(child.id)
      const entry = index.get(child.id)
      if (entry === undefined) continue
      const events = readEvents(entry.path)
      const report = price(events, child.id)
      reports.push(report)
      rows.push({
        id: child.id,
        label: child.label === '' ? (entry.header?.title ?? '') : child.label,
        depth: parent.depth,
        amount: report.amount,
        tokens: report.tokens,
        samples: report.samples
      })
      next.push({ id: child.id, depth: parent.depth + 1, events })
    }
  }
  queue = next
}

const total = combineReports(reports)
console.log('')
console.log(`subagents: ${rows.length}${truncated ? ' (stopped at the depth/node cap)' : ''}`)
for (const row of (showAll ? rows : rows.slice(0, 8))) {
  const label = row.label === '' ? '' : `  ${row.label}`
  console.log(`  ${'  '.repeat(row.depth - 1)}${row.id}  ${money(row.amount)}  (${row.tokens} tokens)${label}`)
}
if (!showAll && rows.length > 8) console.log(`  … ${rows.length - 8} more (--all to list them)`)
console.log('')
console.log(`  own:   ${money(own.amount)}`)
console.log(`  below: ${money(total.amount - own.amount)}`)
console.log(`  total: ${money(total.amount)}`)
const summed = total.lines.reduce((sum, line) => sum + line.amount, 0)
console.log(`  lines add up: ${Math.abs(summed - total.amount) < 1e-9 ? 'yes' : 'NO'}`)
