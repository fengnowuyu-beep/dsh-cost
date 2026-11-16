/**
 * Media spend: image and speech pricing, log folding and the workspace scan.
 *
 * Everything here is offline. The price figures are the vendor's published
 * reference points, so a change to the table should show up as a failing test
 * rather than as a pill that quietly reports a different number.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { combineReports, foldCost, presentCost } from '../lib/cost.js'
import {
  BUILTIN_MEDIA_PRICES,
  DEFAULT_IMAGE_MODEL,
  SPEECH_MODEL,
  combineMedia,
  parseImageResult,
  parseSpeechResult,
  parseWavArgument,
  pixelsFromCall,
  priceImage,
  priceSpeech,
  referenceCount
} from '../lib/media.js'
import { builtinPriceDocument } from '../lib/pricing.js'
import { scanTranscriptUsage, mediaWavsOf, sessionCwd, normalizePath } from '../lib/index.js'
import { close, deepEqual, equal, ok, run, test } from './harness.mjs'

const TABLE = BUILTIN_MEDIA_PRICES
const DOCUMENT = builtinPriceDocument()

/** One tool call event. */
function call(callId, name, args = {}, time = 1794489731451) {
  return { type: 'tool/call', time, data: { name, callId, arguments: JSON.stringify(args) } }
}

/** One tool result event. */
function result(callId, text, time = 1794489732451) {
  return { type: 'tool/result', time, data: { toolCallId: callId, message: { content: [{ type: 'text', text }] } } }
}

/** Fold a sequence of events and present them. */
function reportOf(events, options = {}) {
  const fold = foldCost(events, { document: DOCUMENT, mediaTable: TABLE, ...options })
  return presentCost(fold)
}

// ── parsing ───────────────────────────────────────────────────────────────────

console.log('# parse')

test('a single image result names its model and delivered size', () => {
  const parsed = parseImageResult('Generated one image with openai-compat/MiniMax-H3-Image (832x1248). Attachment ID: sha256:ab…')
  ok(parsed.ok)
  equal(parsed.count, 1)
  equal(parsed.model, 'MiniMax-H3-Image')
  equal(parsed.width, 832)
  equal(parsed.height, 1248)
})

test('an edited image result is recognised as an edit, not a generation', () => {
  const parsed = parseImageResult('Edited one image with openai-compat/MiniMax-H3-Image (1024x1024). The edited image is attached…')
  ok(parsed.ok)
  equal(parsed.count, 1)
  equal(parsed.model, 'MiniMax-H3-Image')
})

test('a batch result carries only a count', () => {
  const parsed = parseImageResult('Generated 4 of 4 images.')
  ok(parsed.ok)
  equal(parsed.count, 4)
  equal(parsed.model, '')
})

test('a provider error is not a billable image', () => {
  const parsed = parseImageResult('Error: openai-compat image request failed (400): {"error":{"message":"invalid params"}}')
  equal(parsed.ok, false)
  equal(parsed.count, 0)
})

test('the transcription script prints the billed seconds', () => {
  const parsed = parseSpeechResult('[done] 128 句, 3 个说话人, 计费 3742s ≈ 0.30 元（95s）')
  equal(parsed.seconds, 3742)
  close(parsed.costCny, 0.3)
})

test('a result that was never billed produces no speech usage', () => {
  equal(parseSpeechResult('[done] 12 句, 1 个说话人（3s）'), null)
})

test('the wav argument is read so a run can be de-duplicated with its file', () => {
  equal(parseWavArgument('python cloud_asr.py --wav "E:\\录音\\ch0.wav" --out-segments x'), 'E:\\录音\\ch0.wav')
  equal(parseWavArgument('python cloud_asr.py --wav E:\\录音\\ch0.wav'), 'E:\\录音\\ch0.wav')
  equal(parseWavArgument('python cloud_asr.py --from-result r.json'), '')
})

test('a size wins over a ratio, and a ratio estimates one megapixel', () => {
  equal(pixelsFromCall({ size: '1024x1536' }), 1024 * 1536)
  equal(pixelsFromCall({ aspect_ratio: '3:4' }), 1024 * 1024)
  equal(pixelsFromCall({}), 1024 * 1024)
})

test('reference images are counted from every way the edit tool accepts them', () => {
  equal(referenceCount({ source_path: 'a.png' }), 1)
  equal(referenceCount({ source_paths: ['a.png', 'b.png', 'c.png'] }), 3)
  equal(referenceCount({ source_attachment_ids: ['x', 'y'] }), 2)
  equal(referenceCount({ source: 'canvas_selection' }), 1)
  equal(referenceCount({}), 0)
})

// ── pricing ──────────────────────────────────────────────────────────────────

console.log('# pricing')

test('an image at the 1K tier costs the published 1K reference', () => {
  const priced = priceImage({ table: TABLE, model: 'MiniMax-H3-Image', pixels: 1024 * 1024, at: Date.parse('2026-11-13T00:00:00Z') })
  close(priced.amount, 0.1430)
  equal(priced.promo, false)
})

test('a 4K image is half price during the published promo and full price after it', () => {
  const during = priceImage({ table: TABLE, model: 'MiniMax-H3-Image', pixels: 4096 * 4096, at: Date.parse('2026-11-13T00:00:00Z') })
  close(during.amount, 0.2261)
  equal(during.promo, true)
  const after = priceImage({ table: TABLE, model: 'MiniMax-H3-Image', pixels: 4096 * 4096, at: Date.parse('2026-12-01T00:00:00Z') })
  close(after.amount, 0.4522)
  equal(after.promo, false)
})

test('a size between tiers interpolates instead of snapping', () => {
  const oneK = priceImage({ table: TABLE, model: 'MiniMax-H3-Image', pixels: 1048576, at: 0 })
  const twoK = priceImage({ table: TABLE, model: 'MiniMax-H3-Image', pixels: 4194304, at: 0 })
  const middle = priceImage({ table: TABLE, model: 'MiniMax-H3-Image', pixels: 2621440, at: 0 })
  ok(middle.amount > oneK.amount && middle.amount < twoK.amount)
  close(middle.amount, (0.1430 + 0.1531) / 2)
})

test('an edit with three references uses the three-reference tier', () => {
  const one = priceImage({ table: TABLE, model: 'MiniMax-H3-Image', mode: 'edit', refs: 1, pixels: 1048576, at: 0 })
  const three = priceImage({ table: TABLE, model: 'MiniMax-H3-Image', mode: 'edit', refs: 3, pixels: 1048576, at: 0 })
  close(one.amount, 0.1744)
  close(three.amount, 0.2346)
})

test('a model without a row is unpriced rather than free', () => {
  equal(priceImage({ table: TABLE, model: 'some-other-model', pixels: 1024 * 1024, at: 0 }), null)
  equal(priceSpeech({ table: TABLE, model: 'whisper', seconds: 10 }), null)
})

test('USD display converts the CNY table with the configured rate', () => {
  const priced = priceImage({ table: TABLE, model: 'MiniMax-H3-Image', pixels: 1024 * 1024, at: 0, currency: 'USD', usdCny: 7.1 })
  close(priced.amount, 0.1430 / 7.1)
})

test('speech is billed per second of speech', () => {
  const priced = priceSpeech({ table: TABLE, model: SPEECH_MODEL, seconds: 3600 })
  close(priced.amount, 0.288)
})

// ── folding ──────────────────────────────────────────────────────────────────

console.log('# folding')

test('an image call and its result add one image to the report', () => {
  const report = reportOf([
    call('c1', 'generate_image', { size: '1024x1024' }),
    result('c1', 'Generated one image with openai-compat/MiniMax-H3-Image (1024x1024). Attachment ID: sha256:ab…')
  ])
  equal(report.media.imageCount, 1)
  equal(report.media.images[0].model, 'MiniMax-H3-Image')
  close(report.media.imageAmount, 0.1430)
  close(report.mediaAmount, 0.1430)
  close(report.totalAmount, 0.1430)
  equal(report.media.promo, undefined)
  ok(report.hasUsage === true)
})

test('a batch result is billed per delivered image, priced from the last known model', () => {
  const report = reportOf([
    call('c1', 'generate_image', { size: '1024x1024' }),
    result('c1', 'Generated one image with openai-compat/MiniMax-H3-Image (1024x1024).'),
    call('c2', 'generate_images', { prompts: ['a', 'b', 'c', 'd'], size: '1024x1024' }),
    result('c2', 'Generated 4 of 4 images.')
  ])
  equal(report.media.imageCount, 5)
  close(report.media.imageAmount, 0.1430 * 5)
})

test('a batch without any earlier single result falls back to the default model', () => {
  const report = reportOf([
    call('c1', 'generate_images', { prompts: ['a', 'b'] }),
    result('c1', 'Generated 2 of 2 images.')
  ])
  equal(report.media.images[0].model, DEFAULT_IMAGE_MODEL)
})

test('a failed call adds no image and no money', () => {
  const report = reportOf([
    call('c1', 'generate_image', { prompt: 'x' }),
    result('c1', 'Error: openai-compat image request failed (400): {"error":{"message":"bad"}}')
  ])
  equal(report.media.imageCount, 0)
  equal(report.mediaAmount, 0)
  equal(report.hasUsage, false)
})

test('an edit result is priced on the edit tier, not the generation tier', () => {
  const report = reportOf([
    call('c1', 'edit_image', { source_path: 'a.png' }),
    result('c1', 'Edited one image with openai-compat/MiniMax-H3-Image (1024x1024).')
  ])
  close(report.media.imageAmount, 0.1744)
})

test('a billed transcription run adds its seconds and its money', () => {
  const report = reportOf([
    call('c1', 'pwsh', { command: 'python cloud_asr.py --wav "E:\\录音\\ch0.wav" --out-segments s.json' }),
    result('c1', '[done] 128 句, 3 个说话人, 计费 3600s ≈ 0.29 元（95s）')
  ])
  equal(report.media.speechRuns, 1)
  equal(report.media.speechSeconds, 3600)
  close(report.media.speechAmount, 0.288)
})

test('a transcription call whose result was never billed is ignored', () => {
  const report = reportOf([
    call('c1', 'pwsh', { command: 'python cloud_asr.py --wav "E:\\录音\\ch0.wav"' }),
    result('c1', 'Traceback (most recent call last): RuntimeError: 缺少百炼 API Key')
  ])
  equal(report.media.speechRuns, 0)
})

// ── merging and the workspace scan ───────────────────────────────────────────

console.log('# merge and scan')

test('combining reports adds media beside the token amount', () => {
  const parent = reportOf([
    call('c1', 'generate_image', { size: '1024x1024' }),
    result('c1', 'Generated one image with openai-compat/MiniMax-H3-Image (1024x1024).')
  ])
  const child = reportOf([
    call('c2', 'generate_image', { size: '1024x1024' }),
    result('c2', 'Generated one image with openai-compat/MiniMax-H3-Image (1024x1024).')
  ])
  const merged = combineReports([parent, child])
  equal(merged.media.imageCount, 2)
  close(merged.media.amount, 0.1430 * 2)
  close(merged.totalAmount, merged.amount + merged.media.amount)
})

test('combining nothing keeps a complete media shape', () => {
  const merged = combineMedia([])
  equal(merged.imageCount, 0)
  equal(merged.hasAny, false)
  deepEqual(merged.images, [])
})

test('the workspace scan reads what a transcription run recorded on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cost-media-'))
  try {
    mkdirSync(join(root, '2026-11-10_会议', '03-数据'), { recursive: true })
    writeFileSync(join(root, '2026-11-10_会议', '03-数据', 'segments-ch0.json'), JSON.stringify({
      wav: join(root, '2026-11-10_会议', 'ch0.wav'),
      cloud: { usage_duration_s: 3600, cost_cny: 0.288 }
    }))
    // A run that was never billed records no usage and must not be counted.
    writeFileSync(join(root, '2026-11-10_会议', '03-数据', 'segments-ch1.json'), JSON.stringify({ wav: 'x', cloud: { usage_duration_s: 0 } }))
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'segments-bogus.json'), JSON.stringify({ cloud: { usage_duration_s: 99999 } }))

    const scanned = scanTranscriptUsage(root)
    equal(scanned.runs.length, 1)
    equal(scanned.runs[0].seconds, 3600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the scan skips directories it must not walk into', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cost-skip-'))
  try {
    mkdirSync(join(root, '.venv', 'lib'), { recursive: true })
    writeFileSync(join(root, '.venv', 'lib', 'segments-x.json'), JSON.stringify({ cloud: { usage_duration_s: 10 } }))
    equal(scanTranscriptUsage(root).runs.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a transcript buried deeper than a project belongs to that project, not to this folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cost-depth-'))
  try {
    // The parent-of-everything case: another workspace's transcripts sit three
    // directories down, and this conversation must not be charged for them.
    mkdirSync(join(root, '录音转写', '2026-11-10_会议', '03-数据'), { recursive: true })
    writeFileSync(join(root, '录音转写', '2026-11-10_会议', '03-数据', 'segments-ch0.json'),
      JSON.stringify({ cloud: { usage_duration_s: 36000 } }))
    equal(scanTranscriptUsage(root).runs.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a discarded run (segments-*.dropped.json) is not counted twice', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cost-dropped-'))
  try {
    mkdirSync(join(root, '2026-11-10_会议', '03-数据'), { recursive: true })
    writeFileSync(join(root, '2026-11-10_会议', '03-数据', 'segments-ch0.dropped.json'), JSON.stringify({ cloud: { usage_duration_s: 3600 } }))
    equal(scanTranscriptUsage(root).runs.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing workspace is not an error', () => {
  deepEqual(scanTranscriptUsage('').runs, [])
  deepEqual(scanTranscriptUsage('Z:\\definitely-not-here').runs, [])
})

test('the session cwd comes from the opening event, and wavs from the calls', () => {
  const events = [
    { type: 'session', cwd: 'E:\\录音转写' },
    call('c1', 'pwsh', { command: 'python cloud_asr.py --wav "E:\\录音转写\\ch0.wav"' }),
    call('c2', 'generate_image', { prompt: 'x' })
  ]
  equal(sessionCwd(events), 'E:\\录音转写')
  const wavs = mediaWavsOf(events)
  equal(wavs.size, 1)
  ok(wavs.has(normalizePath('E:\\录音转写\\ch0.wav')))
})

await run('media')
