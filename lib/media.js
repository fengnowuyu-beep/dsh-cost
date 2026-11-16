/**
 * Media spend for `dsh-cost`: images and speech.
 *
 * The money this plugin used to report was all token money, because the Session
 * log is what the shell's token pill counts. Two services are billed on other
 * units and never appear in that projection:
 *
 *  - **Image generation** (MiniMax H3-Image through the image-gen plugin) is
 *    billed per delivered image, and the price depends on the delivered pixels.
 *  - **Speech recognition** (Alibaba Bailian `paraformer-v2`) is billed per second
 *    of speech.
 *
 * Both calls do leave a trace in the Session log, and that trace is a *result*,
 * not a usage record: the image tool says which model and size it delivered
 * (`Generated one image with openai-compat/MiniMax-H3-Image (832x1248)`), and the
 * transcription script prints what it was billed (`计费 3742s ≈ 0.30 元`). This
 * module turns those strings into units and prices them against the published
 * tables.
 *
 * **These numbers are estimates, and the report says so.** The vendors bill
 * images by token (`¥25 / 1M output tokens`), not by image; the per-image figure
 * below is the vendor's own "单张生成费用参考" for the three published size tiers,
 * interpolated over the delivered pixels. Text input tokens (prompt, and any
 * prompt enhancement) vary per request and are not recoverable from the log, so
 * an image can cost a little more or less than the estimate.
 *
 * @module dsh-cost/media
 */

/** Tools that deliver a billable image. */
export const IMAGE_TOOLS = Object.freeze(new Set(['generate_image', 'generate_images', 'edit_image']))

/** The speech model this table prices, and the only one the recorder emits. */
export const SPEECH_MODEL = 'paraformer-v2'

/** Model used when a batch result carries no model name of its own. */
export const DEFAULT_IMAGE_MODEL = 'MiniMax-H3-Image'

/** Bumped when the shape of {@link BUILTIN_MEDIA_PRICES} changes. */
export const MEDIA_PRICE_VERSION = 1

/**
 * Shipped media prices, in CNY, as published on 2026-11-16.
 *
 * Image figures are the vendor's per-image reference for text-to-image and for
 * editing with one or three reference images, at the three size tiers it
 * publishes. `pixels` is the delivered area of that tier (1024², 2048², 4096²).
 *
 * The 4K promo is real and date-bounded, so it is modelled rather than baked
 * into the tier: any request whose delivered image is at least 16.6 MP, before
 * 2026-11-18 00:00 +08:00, costs half. Dropping it would overstate the very
 * 4K images this user generates.
 *
 * @see https://platform.minimax.cn/docs/pricing/overview
 * @see https://help.aliyun.com/zh/model-studio/paraformer-v2
 */
export const BUILTIN_MEDIA_PRICES = Object.freeze({
  version: MEDIA_PRICE_VERSION,
  source: 'builtin',
  label: 'MiniMax / 阿里云百炼 官方标价（随插件附带，2026-11-16）',
  updatedAt: '2026-11-16T00:00:00.000Z',
  currency: 'CNY',
  images: Object.freeze({
    'MiniMax-H3-Image': Object.freeze({
      displayName: 'MiniMax H3-Image',
      tiers: Object.freeze([
        Object.freeze({ pixels: 1048576, generate: 0.1430, edit1: 0.1744, edit3: 0.2346 }),
        Object.freeze({ pixels: 4194304, generate: 0.1531, edit1: 0.1747, edit3: 0.2746 }),
        Object.freeze({ pixels: 16777216, generate: 0.4522, edit1: 0.4809, edit3: 0.5211 })
      ]),
      promo: Object.freeze({
        minPixels: 16600000,
        factor: 0.5,
        until: '2026-11-18T00:00:00+08:00'
      })
    }),
    'MiniMax-H3-Image-Highspeed': Object.freeze({
      displayName: 'MiniMax H3-Image 极速版',
      tiers: Object.freeze([
        Object.freeze({ pixels: 1048576, generate: 0.2319, edit1: 0.2978, edit3: 0.3982 }),
        Object.freeze({ pixels: 4194304, generate: 0.2380, edit1: 0.3011, edit3: 0.4003 }),
        Object.freeze({ pixels: 16777216, generate: 0.8550, edit1: 0.8998, edit3: 1.0146 })
      ]),
      promo: Object.freeze({
        minPixels: 16600000,
        factor: 0.5,
        until: '2026-11-18T00:00:00+08:00'
      })
    })
  }),
  speech: Object.freeze({
    [SPEECH_MODEL]: Object.freeze({
      displayName: '阿里云百炼 paraformer-v2',
      /** CNY per billed second; silence is not billed. */
      perSecond: 0.00008
    })
  })
})

/** @returns the shipped media table. */
export function builtinMediaPrices() {
  return BUILTIN_MEDIA_PRICES
}

/** Convert a CNY amount into the display currency. */
function inCurrency(amountCny, currency, usdCny) {
  const value = Number(amountCny)
  if (!Number.isFinite(value)) return 0
  if (currency !== 'CNY' && currency !== 'USD') return value
  if (currency === 'CNY') return value
  const rate = Number(usdCny)
  return value / (Number.isFinite(rate) && rate > 0 ? rate : 7.1)
}

/**
 * Interpolate one figure across the published size tiers.
 * Below the smallest tier the smallest price stands; above the largest, the
 * largest does. Between two tiers the price is linear in delivered pixels.
 */
function interpolate(tiers, field, pixels) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null
  const px = Math.max(0, Number(pixels) || 0)
  const first = tiers[0]
  if (px <= first.pixels) return Number(first[field])
  for (let index = 1; index < tiers.length; index += 1) {
    const lower = tiers[index - 1]
    const upper = tiers[index]
    if (px <= upper.pixels) {
      const span = upper.pixels - lower.pixels
      const ratio = span <= 0 ? 0 : (px - lower.pixels) / span
      return Number(lower[field]) + (Number(upper[field]) - Number(lower[field])) * ratio
    }
  }
  return Number(tiers[tiers.length - 1][field])
}

/**
 * Price one delivered image.
 *
 * @param options - media table, model, delivered pixels, mode (`generate`/`edit`),
 *   how many reference images the edit carried, event time, display currency.
 * @returns `{ amount, amountCny, baseCny, promo }`, or null when the model has no
 *   row in the table (which the caller reports as unpriced rather than free).
 */
export function priceImage(options) {
  const { table, model, pixels, mode = 'generate', refs = 0, at, currency = 'CNY', usdCny } = options
  const entry = table?.images?.[model]
  if (entry === undefined || entry === null) return null
  const field = mode === 'edit' ? (Number(refs) >= 3 ? 'edit3' : 'edit1') : 'generate'
  const tierPrice = interpolate(entry.tiers, field, pixels)
  if (tierPrice === null) return null
  let amountCny = tierPrice
  let promo = false
  const promoRule = entry.promo
  if (promoRule !== undefined && promoRule !== null) {
    const until = Date.parse(promoRule.until)
    const when = Number(at)
    const px = Number(pixels) || 0
    if (px >= Number(promoRule.minPixels) && Number.isFinite(until) && Number.isFinite(when) && when < until) {
      amountCny = tierPrice * Number(promoRule.factor)
      promo = true
    }
  }
  return {
    amount: inCurrency(amountCny, currency, usdCny),
    amountCny,
    baseCny: tierPrice,
    promo
  }
}

/**
 * Price one speech run.
 * @param options - media table, model, billed seconds, display currency.
 * @returns `{ amount, amountCny }`, or null when the model is not in the table.
 */
export function priceSpeech(options) {
  const { table, model = SPEECH_MODEL, seconds, currency = 'CNY', usdCny } = options
  const entry = table?.speech?.[model]
  if (entry === undefined || entry === null) return null
  const amountCny = Math.max(0, Number(seconds) || 0) * Number(entry.perSecond ?? 0)
  return { amount: inCurrency(amountCny, currency, usdCny), amountCny }
}

/**
 * Read one image tool result.
 *
 * The image-gen plugin's result text is the only place the delivered model and
 * size appear, and it has exactly two shapes for a success plus one for a
 * failure:
 *
 *   Generated one image with openai-compat/MiniMax-H3-Image (832x1248). …
 *   Edited one image with openai-compat/MiniMax-H3-Image (1024x1024). …
 *   Generated 4 of 4 images.
 *   Error: openai-compat image request failed (400): …
 *
 * @param text - the result text.
 * @returns `{ ok, count, model, width, height }`.
 */
export function parseImageResult(text) {
  const value = typeof text === 'string' ? text : ''
  if (/^\s*Error[:：]/i.test(value)) return { ok: false, count: 0, model: '', width: 0, height: 0 }
  const single = value.match(/(?:Generated|Edited)\s+one\s+image\s+with\s+([^\s/]+)\/(\S+?)\s*\((\d+)\s*[x×]\s*(\d+)\)/i)
  if (single !== null) {
    return {
      ok: true,
      count: 1,
      provider: single[1],
      model: single[2],
      width: Number(single[3]),
      height: Number(single[4])
    }
  }
  const batch = value.match(/Generated\s+(\d+)\s+of\s+(\d+)\s+images?/i)
  if (batch !== null) {
    return {
      ok: true,
      count: Math.max(0, Number(batch[1]) || 0),
      model: '',
      width: 0,
      height: 0
    }
  }
  return { ok: false, count: 0, model: '', width: 0, height: 0 }
}

/**
 * Read the units the transcription script prints when it finishes:
 * `[done] 128 句, 3 个说话人, 计费 3742s ≈ 0.30 元（95s）`.
 * @param text - the result text.
 * @returns `{ seconds, costCny }`, or null when this result was not a billed run.
 */
export function parseSpeechResult(text) {
  const value = typeof text === 'string' ? text : ''
  const match = value.match(/计费\s*([\d.]+)\s*s\s*[≈≈=]\s*([\d.]+)\s*元/)
  if (match !== null) {
    const seconds = Number(match[1])
    if (!Number.isFinite(seconds) || seconds <= 0) return null
    return { seconds, costCny: Number(match[2]) }
  }
  const usage = value.match(/"usage_duration_s"\s*:\s*([\d.]+)/)
  if (usage !== null) {
    const seconds = Number(usage[1])
    if (!Number.isFinite(seconds) || seconds <= 0) return null
    return { seconds, costCny: null }
  }
  return null
}

/** Read a `--wav <path>` argument out of a shell command, so runs can be de-duplicated. */
export function parseWavArgument(command) {
  const value = typeof command === 'string' ? command : ''
  const quoted = value.match(/--wav\s+"([^"]+)"/i)
  if (quoted !== null) return quoted[1]
  const bare = value.match(/--wav\s+([^\s"]+)/i)
  return bare === null ? '' : bare[1]
}

/** The delivered pixel count of one image call, from its size or its ratio. */
export function pixelsFromCall(args) {
  const value = args !== null && typeof args === 'object' ? args : {}
  const size = typeof value.size === 'string' ? value.size.match(/^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i) : null
  if (size !== null) return Number(size[1]) * Number(size[2])
  const ratio = typeof value.aspect_ratio === 'string' ? value.aspect_ratio.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/) : null
  // The image tool defaults to about one megapixel whatever the ratio, so a
  // ratio-only request estimates the same area a size would.
  if (ratio !== null) {
    const width = Number(ratio[1])
    const height = Number(ratio[2])
    if (width > 0 && height > 0) return 1024 * 1024
  }
  return 1024 * 1024
}

/** Count the reference images an edit call carries. */
export function referenceCount(args) {
  const value = args !== null && typeof args === 'object' ? args : {}
  let count = 0
  if (typeof value.source_attachment_id === 'string' && value.source_attachment_id !== '') count += 1
  if (Array.isArray(value.source_attachment_ids)) count += value.source_attachment_ids.length
  if (typeof value.source_path === 'string' && value.source_path !== '') count += 1
  if (Array.isArray(value.source_paths)) count += value.source_paths.length
  if (value.source === 'canvas_selection') count += 1
  return count
}

/** A fresh media accumulator, attached to the token fold. */
export function createMediaState() {
  return {
    /** Per-model image totals, keyed by model id. */
    images: new Map(),
    imageCount: 0,
    imageAmount: 0,
    unpricedImages: 0,
    /** Per-model speech totals, keyed by model id. */
    speech: new Map(),
    speechRuns: 0,
    speechSeconds: 0,
    speechAmount: 0,
    /** `--wav` paths seen in this conversation, used to avoid double counting. */
    speechWavs: new Set(),
    /** The last model a single-image result named, reused for batch results. */
    lastImageModel: '',
    /** Tool calls waiting for their result, keyed by call id. */
    pending: new Map()
  }
}

/** Cap the pending-call map so a log with orphaned calls cannot grow forever. */
const PENDING_LIMIT = 64

/**
 * Fold one event into the media accumulator.
 *
 * Only `tool/call` and `tool/result` matter: the call names the tool and carries
 * the requested size, the result says what was actually delivered (or that the
 * provider refused).
 *
 * @param state - the accumulator.
 * @param event - one Session event.
 * @param options - media table, display currency and rate.
 * @returns the state (mutated).
 */
export function foldMediaEvent(state, event, options) {
  const media = state
  if (media === undefined || media === null) return media
  const type = event?.type

  if (type === 'tool/call') {
    const callId = event?.data?.callId
    if (typeof callId !== 'string' || callId === '') return media
    let args = {}
    const raw = event?.data?.arguments
    if (typeof raw === 'string') {
      try { args = JSON.parse(raw) } catch { args = {} }
    } else if (raw !== null && typeof raw === 'object') {
      args = raw
    }
    const name = typeof event?.data?.name === 'string' ? event.data.name : ''
    if (IMAGE_TOOLS.has(name)) {
      media.pending.set(callId, { name, args, time: Number(event?.time ?? 0) })
      while (media.pending.size > PENDING_LIMIT) {
        const oldest = media.pending.keys().next()
        if (oldest.done === true) break
        media.pending.delete(oldest.value)
      }
      return media
    }
    const wav = parseWavArgument(args?.command)
    if (wav !== '') media.pending.set(callId, { name, args, time: Number(event?.time ?? 0), wav })
    return media
  }

  if (type !== 'tool/result') return media
  const callId = event?.data?.toolCallId ?? event?.data?.message?.toolCallId
  const call = typeof callId === 'string' ? media.pending.get(callId) : undefined
  if (call === undefined) return media
  const text = (event?.data?.message?.content ?? [])
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n')
  const at = Number(event?.time ?? call.time ?? 0)

  if (IMAGE_TOOLS.has(call.name)) {
    const parsed = parseImageResult(text)
    media.pending.delete(callId)
    if (parsed.ok !== true || parsed.count <= 0) return media
    const model = parsed.model !== '' ? parsed.model : (media.lastImageModel !== '' ? media.lastImageModel : DEFAULT_IMAGE_MODEL)
    if (parsed.model !== '') media.lastImageModel = parsed.model
    const mode = call.name === 'edit_image' ? 'edit' : 'generate'
    const refs = mode === 'edit' ? Math.max(1, referenceCount(call.args)) : 0
    const pixels = parsed.width > 0 && parsed.height > 0
      ? parsed.width * parsed.height
      : pixelsFromCall(call.args)
    const priced = priceImage({
      table: options?.mediaTable,
      model,
      pixels,
      mode,
      refs,
      at,
      currency: options?.displayCurrency,
      usdCny: options?.usdCny
    })
    const bucket = media.images.get(model) ?? { model, count: 0, amount: 0, unpricedCount: 0 }
    bucket.count += parsed.count
    media.imageCount += parsed.count
    if (priced === null) {
      bucket.unpricedCount += parsed.count
      media.unpricedImages += parsed.count
    } else {
      bucket.amount += priced.amount * parsed.count
      media.imageAmount += priced.amount * parsed.count
    }
    media.images.set(model, bucket)
    return media
  }

  if (call.wav !== undefined && call.wav !== '') {
    media.pending.delete(callId)
    const speech = parseSpeechResult(text)
    if (speech === null) return media
    media.speechWavs.add(call.wav)
    const model = SPEECH_MODEL
    const priced = priceSpeech({
      table: options?.mediaTable,
      model,
      seconds: speech.seconds,
      currency: options?.displayCurrency,
      usdCny: options?.usdCny
    })
    const bucket = media.speech.get(model) ?? { model, runs: 0, seconds: 0, amount: 0 }
    bucket.runs += 1
    bucket.seconds += speech.seconds
    bucket.amount += priced?.amount ?? 0
    media.speech.set(model, bucket)
    media.speechRuns += 1
    media.speechSeconds += speech.seconds
    media.speechAmount += priced?.amount ?? 0
  }
  return media
}

/**
 * Present the media accumulator as JSON for the browser half.
 * @param state - the accumulator.
 * @returns a JSON-safe media report.
 */
export function presentMedia(state) {
  const media = state ?? createMediaState()
  const images = [...media.images.values()]
    .map(entry => ({ model: entry.model, count: entry.count, amount: entry.amount, unpricedCount: entry.unpricedCount }))
    .sort((left, right) => right.amount - left.amount || right.count - left.count)
  const speech = [...media.speech.values()]
    .map(entry => ({ model: entry.model, runs: entry.runs, seconds: entry.seconds, amount: entry.amount }))
    .sort((left, right) => right.amount - left.amount || right.seconds - left.seconds)
  return {
    images,
    imageCount: media.imageCount,
    imageAmount: media.imageAmount,
    unpricedImages: media.unpricedImages,
    speech,
    speechRuns: media.speechRuns,
    speechSeconds: media.speechSeconds,
    speechAmount: media.speechAmount,
    amount: media.imageAmount + media.speechAmount,
    hasAny: media.imageCount > 0 || media.speechRuns > 0
  }
}

/**
 * Merge presented media reports (a conversation plus its subagents).
 * @param reports - presented media reports.
 * @returns one merged report.
 */
export function combineMedia(reports = []) {
  const images = new Map()
  const speech = new Map()
  let imageCount = 0
  let imageAmount = 0
  let unpricedImages = 0
  let speechRuns = 0
  let speechSeconds = 0
  let speechAmount = 0
  for (const report of reports) {
    if (report === undefined || report === null) continue
    imageCount += Number(report.imageCount ?? 0)
    imageAmount += Number(report.imageAmount ?? 0)
    unpricedImages += Number(report.unpricedImages ?? 0)
    speechRuns += Number(report.speechRuns ?? 0)
    speechSeconds += Number(report.speechSeconds ?? 0)
    speechAmount += Number(report.speechAmount ?? 0)
    for (const entry of report.images ?? []) {
      const current = images.get(entry?.model) ?? { model: entry?.model, count: 0, amount: 0, unpricedCount: 0 }
      current.count += Number(entry?.count ?? 0)
      current.amount += Number(entry?.amount ?? 0)
      current.unpricedCount += Number(entry?.unpricedCount ?? 0)
      images.set(entry?.model, current)
    }
    for (const entry of report.speech ?? []) {
      const current = speech.get(entry?.model) ?? { model: entry?.model, runs: 0, seconds: 0, amount: 0 }
      current.runs += Number(entry?.runs ?? 0)
      current.seconds += Number(entry?.seconds ?? 0)
      current.amount += Number(entry?.amount ?? 0)
      speech.set(entry?.model, current)
    }
  }
  return {
    images: [...images.values()].sort((left, right) => right.amount - left.amount || right.count - left.count),
    imageCount,
    imageAmount,
    unpricedImages,
    speech: [...speech.values()].sort((left, right) => right.amount - left.amount || right.seconds - left.seconds),
    speechRuns,
    speechSeconds,
    speechAmount,
    amount: imageAmount + speechAmount,
    hasAny: imageCount > 0 || speechRuns > 0
  }
}
