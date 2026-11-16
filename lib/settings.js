/**
 * Settings contract for `dsh-cost`.
 *
 * Three layers resolve into one live document, lowest first:
 *
 *   1. {@link DEFAULTS} — the shipped behaviour,
 *   2. the plugin's Loader `config:` block (profile-level defaults),
 *   3. `<dshHome>/cost/settings.json` (what the DSH settings page writes).
 *
 * Every field is normalised on read, so a hand-edited file, a partial config
 * block, or a document written by an older version can never hand the rest of
 * the plugin a malformed shape. A plugin whose own settings are corrupt falls
 * back to the shipped defaults rather than failing to mount.
 *
 * @module dsh-cost/settings
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Settings document version this build writes. */
export const SETTINGS_VERSION = 1

/** Currencies the spend readout can display. */
export const CURRENCIES = Object.freeze(['CNY', 'USD'])

/** Where a price table comes from. */
export const PRICING_SOURCES = Object.freeze(['auto', 'deepseek-docs', 'json', 'builtin'])

/** Official DeepSeek pricing pages, English (USD) then Simplified Chinese (CNY). */
export const OFFICIAL_PRICING_URLS = Object.freeze([
  'https://api-docs.deepseek.com/quick_start/pricing/',
  'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
])

/** Shipped defaults. */
export const DEFAULTS = Object.freeze({
  version: SETTINGS_VERSION,
  /** The spend readout itself. */
  enabled: true,
  cost: Object.freeze({
    /** Currency the readout uses. */
    currency: 'CNY',
    /** Fallback exchange rate used when a model has no table in the display currency. */
    usdCny: 7.1,
    /** Show the amount next to the token pill under the composer. */
    showInComposer: true,
    /** `auto` probes the official docs, then falls back to the shipped table. */
    pricingSource: 'auto',
    /** Explicit JSON price-document URL for `pricingSource: 'json'`. */
    pricingUrl: '',
    /** Refresh the price table in the background when it is stale. */
    autoRefreshPrices: true,
    /** How long a fetched price table stays fresh, in hours. */
    refreshHours: 168,
    /** Include the conversations this one delegated to, recursively. */
    includeSubagents: true,
    /** Count image and speech spend in the conversation total. */
    includeMedia: true,
    /** Add transcription runs recorded in the workspace, not only in the log. */
    includeWorkspaceSpeech: true
  })
})

/** @returns the directory holding this plugin's runtime state. */
export function stateDir(dshHome) {
  return join(dshHome, 'cost')
}

/** @returns the settings document path. */
export function settingsPath(dshHome) {
  return join(stateDir(dshHome), 'settings.json')
}

/** @returns the cached price-document path. */
export function pricesPath(dshHome) {
  return join(stateDir(dshHome), 'prices.json')
}

/** @returns the audited operations log directory. */
export function logsDir(dshHome) {
  return join(stateDir(dshHome), 'logs')
}

/**
 * Where the cost feature lived before it was its own plugin. Read once, so the
 * split does not throw away the user's currency, exchange rate and price cache.
 * @param dshHome - resolved harness home.
 * @returns `{ settingsFile, pricesFile }`.
 */
export function legacyPaths(dshHome) {
  const legacy = join(dshHome, 'toolbox')
  return { settingsFile: join(legacy, 'settings.json'), pricesFile: join(legacy, 'prices.json') }
}

/**
 * Resolve the harness home the same way `@deepseek-ai/dsh-home-paths` does:
 * an explicit configured path, then `$DSH_HOME`, then `~/.dsh`. The Host process
 * does not inherit `$DSH_HOME` (only tool shells do), so the default must stand
 * on its own.
 * @param configured - optional `dshHome` from the plugin's own config.
 * @returns the harness home directory.
 */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** Trim a value to a non-empty string, or return the fallback. */
function asText(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

/** Coerce a value into a bounded number. */
function asNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}

/** Coerce a value into a boolean with a fallback. */
function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Coerce a value into one of a fixed string set. */
function asEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/**
 * Coerce an arbitrary object into the settings contract.
 * @param raw - the candidate document or config object.
 * @returns a complete, valid settings object.
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const cost = source.cost !== null && typeof source.cost === 'object' ? source.cost : {}

  return {
    version: SETTINGS_VERSION,
    // `enabled` and the nested `showInComposer` are separate on purpose: one hides
    // the plugin, the other keeps pricing warm while the pill is not drawn.
    enabled: asBoolean(source.enabled, DEFAULTS.enabled),
    cost: {
      currency: asEnum(cost.currency, CURRENCIES, DEFAULTS.cost.currency),
      usdCny: asNumber(cost.usdCny, DEFAULTS.cost.usdCny, 0.01, 1000),
      showInComposer: asBoolean(cost.showInComposer, DEFAULTS.cost.showInComposer),
      pricingSource: asEnum(cost.pricingSource, PRICING_SOURCES, DEFAULTS.cost.pricingSource),
      pricingUrl: asText(cost.pricingUrl, ''),
      autoRefreshPrices: asBoolean(cost.autoRefreshPrices, DEFAULTS.cost.autoRefreshPrices),
      refreshHours: asNumber(cost.refreshHours, DEFAULTS.cost.refreshHours, 1, 24 * 365),
      includeSubagents: asBoolean(cost.includeSubagents, DEFAULTS.cost.includeSubagents),
      includeMedia: asBoolean(cost.includeMedia, DEFAULTS.cost.includeMedia),
      includeWorkspaceSpeech: asBoolean(cost.includeWorkspaceSpeech, DEFAULTS.cost.includeWorkspaceSpeech)
    }
  }
}

/**
 * Read the persisted document.
 *
 * The very first run after the split finds nothing of its own; when the old
 * combined plugin has a `cost` block, that block is adopted (and written back
 * here) so the user's currency and exchange rate survive the move. The old file
 * is never modified — it still belongs to the other plugin.
 *
 * @param logger - optional Cordis logger.
 * @param dshHome - resolved harness home.
 * @returns the persisted object exactly as stored (`{}` when absent/unreadable).
 */
export function loadPersisted(logger, dshHome) {
  const file = settingsPath(dshHome)
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    }
    const legacy = legacyPaths(dshHome).settingsFile
    if (!existsSync(legacy)) return {}
    const parsed = JSON.parse(readFileSync(legacy, 'utf8'))
    const cost = parsed?.cost
    if (cost === null || typeof cost !== 'object') return {}
    logger?.info?.('cost: adopting the spend settings from the toolbox plugin')
    return { enabled: parsed?.enabled !== false, cost }
  } catch (error) {
    logger?.warn?.(`cost: settings unreadable, using defaults: ${String(error)}`)
    return {}
  }
}

/**
 * Copy the old price cache into this plugin's own state directory, once.
 * @param dshHome - resolved harness home.
 * @returns whether a cache was found.
 */
export function migrateCachedPrices(dshHome) {
  try {
    const own = pricesPath(dshHome)
    if (existsSync(own)) return true
    const legacy = legacyPaths(dshHome).pricesFile
    if (!existsSync(legacy)) return false
    const parsed = JSON.parse(readFileSync(legacy, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return false
    const target = stateDir(dshHome)
    mkdirSyncRecursive(target)
    writeFileSyncAtomic(own, `${JSON.stringify(parsed, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/** Timers and half-written files are the classic way a cache directory breaks. */
function mkdirSyncRecursive(directory) {
  try {
    // A synchronous mkdir here keeps the migration inside the constructor, where
    // the caller has no await to spend on it.
    mkdirSync(directory, { recursive: true })
  } catch {
    /* already exists, or unwritable: the cache write below reports the truth */
  }
}

/** Write one small file atomically, synchronously. */
function writeFileSyncAtomic(file, text) {
  try {
    writeFileSync(`${file}.tmp`, text)
    renameSync(`${file}.tmp`, file)
  } catch {
    /* the cache is an optimisation; a failed copy is not fatal */
  }
}

/** Merge one key across the two lower layers. */
function mergeLayer(base, stored) {
  if (stored === undefined) return base
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return stored
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return stored
  const merged = { ...base }
  for (const [key, value] of Object.entries(stored)) {
    if (value !== undefined) merged[key] = value
  }
  return merged
}

/**
 * Merge the layers into one live document. The settings page always writes every
 * key, so a persisted value replaces the config one; a partial persisted value
 * still falls back to the config block field by field.
 * @param persisted - whatever `settings.json` held.
 * @param configured - the Loader `config:` block.
 * @returns the effective settings.
 */
export function composeSettings(persisted, configured) {
  const base = normalizeSettings(configured ?? {})
  const stored = persisted !== null && typeof persisted === 'object' ? persisted : {}
  const merged = {}
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'version') continue
    merged[key] = mergeLayer(base[key], stored[key])
  }
  const effective = normalizeSettings(merged)
  // The page's own version wins so the document is always stamped current.
  effective.version = SETTINGS_VERSION
  return effective
}

/** Atomically persist the settings document. */
export async function savePersisted(document, dshHome) {
  const file = settingsPath(dshHome)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * The settings projection the browser half consumes.
 * @param settings - effective settings.
 * @param dshHome - resolved harness home.
 * @param extras - live facts (plugin version, paths).
 * @returns a JSON-safe view.
 */
export function publicSettings(settings, dshHome, extras = {}) {
  return {
    ...settings,
    ...extras,
    settingsFile: settingsPath(dshHome),
    pricesFile: pricesPath(dshHome),
    stateDir: stateDir(dshHome)
  }
}
