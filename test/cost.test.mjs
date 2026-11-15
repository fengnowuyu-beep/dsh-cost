/** Spend: the fold's replacement rules, per-model pricing, and the memo. */

import { close, deepEqual, equal, ok, run, test } from './harness.mjs'
import {
  BILLING_KINDS,
  combineReports,
  createCostLedger,
  emptyLines,
  foldCost,
  presentCost,
  priceBuckets,
  totalTokens,
  zeroBuckets
} from '../lib/cost.js'
import { builtinPriceDocument } from '../lib/pricing.js'

const DOCUMENT = builtinPriceDocument()

/** One billing line of a presented report, by kind. */
function lineOf(result, kind) {
  const line = result.lines.find(entry => entry.kind === kind)
  ok(line !== undefined, `${kind} must be reported`)
  return line
}

/** One `assistant/message` event. */
function assistant(seq, turn, step, usage, model = 'deepseek-flash', time = Date.parse('2026-10-09T05:00:00Z')) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn,
      step,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model } },
      stream: [],
      usage
    }
  }
}

/** One usage sample. */
function usage(input, output, cacheRead = 0, cacheWrite = 0) {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
}

/** Fold a list of events into a presented report. */
function report(events, options = {}) {
  const fold = foldCost(events, {
    document: DOCUMENT,
    displayCurrency: 'CNY',
    usdCny: 7.1,
    ...options
  })
  return presentCost(fold, {})
}

test('cache hits, misses and output are priced at their own rates', () => {
  // 1M uncached input (¥1), 1M cache hit (¥0.02), 1M output (¥4) off-peak.
  const result = report([assistant(0, 0, 0, usage(1_000_000, 1_000_000, 1_000_000))])
  close(result.amount, 1 + 0.02 + 4, 1e-9)
  close(result.buckets.uncachedInputTokens, 1_000_000)
  close(result.buckets.cacheReadTokens, 1_000_000)
  close(result.buckets.outputTokens, 1_000_000)
  equal(result.samples, 1)
  equal(result.peakSamples, 0)
})

test('a peak-hour sample costs twice an off-peak one', () => {
  const offPeak = report([assistant(0, 0, 0, usage(1_000_000, 1_000_000), 'deepseek-flash', Date.parse('2026-10-09T05:00:00Z'))])
  const peak = report([assistant(0, 0, 0, usage(1_000_000, 1_000_000), 'deepseek-flash', Date.parse('2026-10-09T02:00:00Z'))])
  close(peak.amount, offPeak.amount * 2, 1e-9)
  equal(peak.peakSamples, 1)
})

test('each sample is priced at the hour it was reported', () => {
  const result = report([
    assistant(0, 0, 0, usage(1_000_000, 0), 'deepseek-flash', Date.parse('2026-10-09T02:00:00Z')),
    assistant(1, 1, 0, usage(1_000_000, 0), 'deepseek-flash', Date.parse('2026-10-09T05:00:00Z'))
  ])
  close(result.amount, 2 + 1, 1e-9)
  equal(result.samples, 2)
  equal(result.peakSamples, 1)
})

test('cache writes are billed at the cache-miss rate', () => {
  const result = report([assistant(0, 0, 0, usage(0, 0, 0, 1_000_000))])
  close(result.amount, 1, 1e-9)
})

test('a repeated (turn, step) replaces its sample instead of adding one', () => {
  const result = report([
    assistant(0, 0, 0, usage(1_000_000, 0)),
    assistant(1, 0, 0, usage(2_000_000, 0))
  ])
  equal(result.samples, 1)
  close(result.buckets.uncachedInputTokens, 2_000_000)
  close(result.amount, 2, 1e-9)
})

test('an identical repeated sample is ignored entirely', () => {
  const result = report([
    assistant(0, 0, 0, usage(1_000_000, 10)),
    assistant(1, 0, 0, usage(1_000_000, 10))
  ])
  equal(result.samples, 1)
})

test('a retry clears the attempt it replaces', () => {
  const result = report([
    assistant(0, 0, 0, usage(1_000_000, 0)),
    { type: 'llm/retry-started', seq: 1, time: Date.now(), data: { turn: 0, step: 0 } },
    assistant(2, 0, 0, usage(500_000, 0))
  ])
  equal(result.samples, 1)
  close(result.buckets.uncachedInputTokens, 500_000)
  close(result.amount, 0.5, 1e-9)
})

test('a retry for another step leaves the previous sample alone', () => {
  const result = report([
    assistant(0, 0, 0, usage(1_000_000, 0)),
    { type: 'llm/retry-started', seq: 1, time: Date.now(), data: { turn: 0, step: 1 } },
    assistant(2, 0, 1, usage(500_000, 0))
  ])
  close(result.buckets.uncachedInputTokens, 1_500_000)
  equal(result.samples, 2)
})

test('usage inside an attempt stream is priced too', () => {
  // A retried attempt reaches the log as `assistant/attempt`: the sample lives
  // inside the stream, and the model comes from the request header in force.
  const result = report([
    { type: 'request/header', seq: 0, time: 0, data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } }, reason: 'initial' } },
    {
      type: 'assistant/attempt',
      seq: 1,
      time: Date.parse('2026-10-09T05:00:00Z'),
      data: {
        turn: 0,
        step: 0,
        stream: [
          { type: 'text-chunks', time0: 0, index: 0, dt: [], texts: [] },
          { type: 'chunk', time: 0, chunk: { type: 'usage', usage: usage(1_000_000, 1_000_000) } },
          { type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } }
        ]
      }
    }
  ])
  close(result.amount, 1 + 4, 1e-9)
})

test('an attempt stream with no known route is counted as unpriced', () => {
  const result = report([{
    type: 'assistant/attempt',
    seq: 0,
    time: Date.parse('2026-10-09T05:00:00Z'),
    data: {
      turn: 0,
      step: 0,
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: usage(1_000_000, 0) } }]
    }
  }])
  equal(result.amount, 0)
  equal(result.samples, 1)
  equal(result.unpricedTokens, 1_000_000)
})

test('a model is taken from the message source, else from the request route', () => {
  const routed = report([
    { type: 'request/header', seq: 0, time: 0, data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, reason: 'initial' } },
    {
      type: 'assistant/message',
      seq: 1,
      time: Date.parse('2026-10-09T05:00:00Z'),
      data: { turn: 0, step: 0, message: { role: 'assistant', source: { kind: 'model' } }, stream: [], usage: usage(1_000_000, 0) }
    }
  ])
  // Off-peak cache-miss for v4-pro is ¥4.5.
  close(routed.amount, 4.5, 1e-9)
  equal(routed.byModel.length, 1)
  equal(routed.byModel[0].model, 'deepseek-v4-pro')
})

test('request/context also supplies the route', () => {
  const result = report([
    { type: 'request/context', seq: 0, time: 0, data: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
    {
      type: 'assistant/message',
      seq: 1,
      time: Date.parse('2026-10-09T05:00:00Z'),
      data: { turn: 0, step: 0, message: { role: 'assistant', source: { kind: 'model' } }, stream: [], usage: usage(1_000_000, 0) }
    }
  ])
  close(result.amount, 4.5, 1e-9)
})

test('several models in one conversation are reported separately', () => {
  const result = report([
    assistant(0, 0, 0, usage(1_000_000, 0), 'deepseek-flash'),
    assistant(1, 1, 0, usage(1_000_000, 0), 'deepseek-v4-pro')
  ])
  close(result.amount, 1 + 4.5, 1e-9)
  equal(result.byModel.length, 2)
  close(result.byModel[0].amount, 4.5, 1e-9)
  close(result.byModel[1].amount, 1, 1e-9)
})

test('an unpriced model is counted, not silently priced at zero', () => {
  const result = report([assistant(0, 0, 0, usage(1_000_000, 1_000_000), 'gpt-5')])
  equal(result.amount, 0)
  equal(result.unpricedTokens, 2_000_000)
  deepEqual(result.unpricedModels, ['gpt-5'])
  equal(result.byModel.length, 0)
})

test('a USD readout prices from the USD table', () => {
  const result = report([assistant(0, 0, 0, usage(0, 1_000_000))], { displayCurrency: 'USD' })
  close(result.amount, 0.6, 1e-9)
})

test('a model published in only one currency converts instead of going unpriced', () => {
  const usdOnly = {
    ...DOCUMENT,
    models: { 'deepseek-flash': { USD: DOCUMENT.models['deepseek-flash'].USD } }
  }
  const fold = foldCost([assistant(0, 0, 0, usage(0, 1_000_000))], {
    document: usdOnly,
    displayCurrency: 'CNY',
    usdCny: 7
  })
  const result = presentCost(fold, {})
  close(result.amount, 0.6 * 7, 1e-9)
  equal(result.unpricedTokens, 0)
})

test('an empty log reports nothing billable', () => {
  const result = report([])
  equal(result.hasUsage, false)
  equal(result.amount, 0)
  equal(result.samples, 0)
  deepEqual(result.buckets, zeroBuckets())
})

test('a session with only conversation events stays unbilled', () => {
  const result = report([
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, time: 1, data: { role: 'user' } }
  ])
  equal(result.hasUsage, false)
  equal(result.amount, 0)
})

test('priceBuckets reports which lines it could not price', () => {
  const missing = priceBuckets({
    entry: { CNY: { output: { offPeak: 1, peak: 1 } } },
    displayCurrency: 'CNY',
    usdCny: 7,
    peak: false,
    buckets: { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 }
  })
  equal(missing.priced, 20)
  deepEqual(missing.missing, [{ kind: 'cacheMiss', tokens: 10 }])
})

test('the ledger memoises an unchanged session and folds only new events', () => {
  const events = [assistant(0, 0, 0, usage(1_000_000, 0))]
  const session = {
    id: 'session-1',
    seq: 1,
    firstLiveSeq: 0,
    snapshotEvents: (fromSeq = 0) => events.filter(event => event.seq >= fromSeq)
  }
  const ledger = createCostLedger({ limit: 4 })
  const context = { document: DOCUMENT, documentStamp: 'a', displayCurrency: 'CNY', usdCny: 7.1 }

  const first = ledger.compute(session, context)
  close(first.amount, 1, 1e-9)
  equal(ledger.size, 1)

  // Same watermark: the memo answers without re-reading.
  const second = ledger.compute(session, context)
  equal(second, first)

  // The log advances: only the appended sample is folded in.
  events.push(assistant(1, 1, 0, usage(0, 1_000_000)))
  session.seq = 2
  const third = ledger.compute(session, context)
  close(third.amount, 1 + 4, 1e-9)
  equal(third.samples, 2)

  // A different price document drops the memo.
  ledger.invalidate()
  equal(ledger.size, 0)
})

test('the ledger keeps a different session separate and bounds its memory', () => {
  const make = (id, amount) => ({
    id,
    seq: 1,
    snapshotEvents: () => [assistant(0, 0, 0, usage(amount, 0))]
  })
  const ledger = createCostLedger({ limit: 2 })
  const context = { document: DOCUMENT, documentStamp: 'a', displayCurrency: 'CNY', usdCny: 7.1 }
  ledger.compute(make('a', 1_000_000), context)
  ledger.compute(make('b', 2_000_000), context)
  ledger.compute(make('c', 3_000_000), context)
  equal(ledger.size, 2)
  close(ledger.compute(make('c', 3_000_000), context).amount, 3, 1e-9)
})

test('a session whose snapshotEvents throws costs nothing instead of failing the route', () => {
  const session = { id: 'broken', seq: 5, snapshotEvents: () => { throw new Error('gone') } }
  const ledger = createCostLedger()
  const result = ledger.compute(session, { document: DOCUMENT, documentStamp: 'a', displayCurrency: 'CNY', usdCny: 7.1 })
  equal(result.hasUsage, false)
  equal(result.amount, 0)
})

test('totalTokens sums every bucket', () => {
  equal(totalTokens({ uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 }), 10)
})

test('the same events always fold to the same number', () => {
  const events = [
    assistant(0, 0, 0, usage(120_000, 4_000, 800_000)),
    assistant(1, 1, 0, usage(30_000, 2_000, 900_000), 'deepseek-v4-pro')
  ]
  const once = report(events).amount
  const twice = report(events).amount
  equal(once, twice)
  ok(once > 0)
  ok(Number.isFinite(once))
})

// ── the amount breakdown ────────────────────────────────────────────────────

test('each billing line carries its own amount, not just its token count', () => {
  // Off-peak flash, one million tokens per line:
  //   cache miss ¥1 · cache hit ¥0.02 · cache write ¥1 (billed as a miss) · output ¥4
  const result = report([assistant(0, 0, 0, usage(1_000_000, 1_000_000, 1_000_000, 1_000_000))])
  close(lineOf(result, 'cacheMiss').amount, 1, 1e-9)
  close(lineOf(result, 'cacheHit').amount, 0.02, 1e-9)
  close(lineOf(result, 'cacheWrite').amount, 1, 1e-9)
  close(lineOf(result, 'output').amount, 4, 1e-9)

  equal(lineOf(result, 'cacheMiss').tokens, 1_000_000)
  equal(lineOf(result, 'cacheHit').tokens, 1_000_000)
  equal(lineOf(result, 'cacheWrite').tokens, 1_000_000)
  equal(lineOf(result, 'output').tokens, 1_000_000)

  // The lines must add up to the headline number, or the panel would contradict itself.
  const summed = result.lines.reduce((total, line) => total + line.amount, 0)
  close(summed, result.amount, 1e-9)
  close(summed, 6.02, 1e-9)
})

test('the breakdown is reported in billing order, with every kind present', () => {
  const result = report([assistant(0, 0, 0, usage(10, 10))])
  deepEqual(result.lines.map(line => line.kind), [...BILLING_KINDS])
  // A kind this conversation never used reports a zero rather than vanishing.
  equal(lineOf(result, 'cacheWrite').tokens, 0)
  close(lineOf(result, 'cacheWrite').amount, 0, 1e-9)
})

test('a peak sample doubles every line it touches', () => {
  const offPeak = report([assistant(0, 0, 0, usage(1_000_000, 1_000_000, 1_000_000), 'deepseek-flash', Date.parse('2026-10-09T05:00:00Z'))])
  const peak = report([assistant(0, 0, 0, usage(1_000_000, 1_000_000, 1_000_000), 'deepseek-flash', Date.parse('2026-10-09T02:00:00Z'))])
  for (const kind of ['cacheMiss', 'cacheHit', 'output']) {
    close(lineOf(peak, kind).amount, lineOf(offPeak, kind).amount * 2, 1e-9)
  }
})

test('replacing a sample corrects the lines it contributed', () => {
  const result = report([
    assistant(0, 0, 0, usage(1_000_000, 1_000_000)),
    // Same (turn, step): this replaces the sample above rather than adding one.
    assistant(1, 0, 0, usage(250_000, 500_000))
  ])
  equal(lineOf(result, 'cacheMiss').tokens, 250_000)
  close(lineOf(result, 'cacheMiss').amount, 0.25, 1e-9)
  equal(lineOf(result, 'output').tokens, 500_000)
  close(lineOf(result, 'output').amount, 2, 1e-9)
  close(result.amount, 2.25, 1e-9)
})

test('a retry clears the lines of the attempt it replaces', () => {
  const result = report([
    assistant(0, 0, 0, usage(1_000_000, 1_000_000)),
    { type: 'llm/retry-started', seq: 1, time: Date.now(), data: { turn: 0, step: 0 } },
    assistant(2, 0, 0, usage(0, 100_000))
  ])
  equal(lineOf(result, 'cacheMiss').tokens, 0)
  close(lineOf(result, 'cacheMiss').amount, 0, 1e-9)
  close(lineOf(result, 'output').amount, 0.4, 1e-9)
  close(result.amount, 0.4, 1e-9)
})

test('an unpriced model keeps its tokens visible on every line it used', () => {
  const result = report([assistant(0, 0, 0, usage(1_000_000, 500_000), 'gpt-5')])
  equal(result.amount, 0)
  equal(lineOf(result, 'cacheMiss').tokens, 1_000_000)
  equal(lineOf(result, 'cacheMiss').amount, 0)
  equal(lineOf(result, 'cacheMiss').unpricedTokens, 1_000_000)
  equal(lineOf(result, 'output').tokens, 500_000)
  equal(lineOf(result, 'output').amount, 0)
  equal(lineOf(result, 'output').unpricedTokens, 500_000)
  equal(lineOf(result, 'cacheWrite').unpricedTokens, 0)
})

test('a line priced only in the other currency still carries its amount', () => {
  const usdOnly = {
    ...DOCUMENT,
    models: { 'deepseek-flash': { USD: DOCUMENT.models['deepseek-flash'].USD } }
  }
  const result = report([assistant(0, 0, 0, usage(0, 1_000_000))], { document: usdOnly, displayCurrency: 'CNY', usdCny: 7 })
  close(lineOf(result, 'output').amount, 0.6 * 7, 1e-9)
  close(result.amount, 0.6 * 7, 1e-9)
})

test('priceBuckets reports per-kind amounts and which kinds it could not price', () => {
  const priced = priceBuckets({
    entry: { CNY: { output: { offPeak: 1, peak: 1 }, cacheMiss: { offPeak: 2, peak: 2 } } },
    displayCurrency: 'CNY',
    usdCny: 7,
    peak: false,
    buckets: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 }
  })
  close(priced.lines.cacheMiss.amount, 2, 1e-9)
  close(priced.lines.output.amount, 1, 1e-9)
  close(priced.amount, 3, 1e-9)
  equal(priced.lines.cacheHit.tokens, 0)
  deepEqual(priced.missing, [])
})

test('an empty lines record has every kind and no cost', () => {
  const lines = emptyLines()
  deepEqual(Object.keys(lines), [...BILLING_KINDS])
  for (const kind of BILLING_KINDS) {
    equal(lines[kind].tokens, 0)
    equal(lines[kind].amount, 0)
    equal(lines[kind].unpricedTokens, 0)
  }
})

test('a report with no usage still answers with a complete breakdown', () => {
  const result = report([])
  equal(result.hasUsage, false)
  deepEqual(result.lines.map(line => line.kind), [...BILLING_KINDS])
  close(result.lines.reduce((total, line) => total + line.amount, 0), 0, 1e-9)
})

test('combining reports adds every line, bucket and model', () => {
  const peak = Date.parse('2026-10-09T02:00:00Z')
  const main = report([assistant(0, 0, 0, usage(1_000_000, 0), 'deepseek-flash', peak)])
  const child = report([assistant(0, 0, 0, usage(0, 1_000_000), 'deepseek-flash', peak)])
  const combined = combineReports([main, child])

  close(combined.amount, main.amount + child.amount, 1e-12, 'the total is the sum')
  equal(combined.tokens, main.tokens + child.tokens)
  equal(combined.samples, main.samples + child.samples)
  equal(combined.buckets.uncachedInputTokens, main.buckets.uncachedInputTokens + child.buckets.uncachedInputTokens)
  equal(combined.buckets.outputTokens, main.buckets.outputTokens + child.buckets.outputTokens)
  // Buckets are keyed by token fields and lines by billing kinds: mixing the two
  // namespaces silently produced NaN totals once already.
  equal(Number.isFinite(combined.amount), true)
  equal(Number.isFinite(combined.tokens), true)
  for (const kind of BILLING_KINDS) {
    const line = combined.lines.find(entry => entry.kind === kind)
    ok(line !== undefined, `line ${kind} must be present`)
    equal(Number.isFinite(line.amount), true, `line ${kind} must be numeric`)
  }
  deepEqual(combined.lines.map(line => line.kind), [...BILLING_KINDS], 'and in billing order')
  close(combined.lines.reduce((total, line) => total + line.amount, 0), combined.amount, 1e-12, 'lines still add up')
  equal(combined.byModel.length, 1, 'the same model from two sessions is one row')
  close(combined.byModel[0].amount, combined.amount, 1e-12)
  equal(combined.hasUsage, true)
})

test('combining nothing is still a well-formed zero report', () => {
  const combined = combineReports([])
  equal(combined.amount, 0)
  equal(combined.tokens, 0)
  equal(combined.hasUsage, false)
  deepEqual(combined.lines.map(line => line.kind), [...BILLING_KINDS])
  deepEqual(combined.byModel, [])
})

await run('cost')
