/**
 * dsh-cost — browser half.
 *
 * Two contributions, both driven by the Host half so the two can never disagree
 * about a number:
 *
 *  1. `conversation.composer.dock` — the conversation's spend, right next to the
 *     token pill the shell already draws there. Clicking it opens the breakdown:
 *     every billing line, the subagent share, and the price table in force.
 *  2. `settings.section` — the money page: display currency, exchange rate, the
 *     price source, and a manual refresh.
 *
 * Nothing here computes a price. The Host folds the Session log and prices it
 * (the same events the shell's token pill counts), so a wrong number is always a
 * Host bug and never a disagreement between two implementations.
 */

window.__ModuleLoader__.load({
  id: 'dsh-cost',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const reactDom = require('react-dom')
    const React = react.default ?? react
    const { createElement: h, useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'cost'

    /** Host route family mounted by the Node half. */
    const ROUTE = '/dsh-cost/api'

    /** Marks this plugin's own DOM, so it can never be mistaken for the shell's. */
    const OWN_ROOT_ATTRIBUTE = 'data-dsh-cost-root'

    // ── small utilities ───────────────────────────────────────────────────────

    /**
     * A minimal external store, so React reads plugin state through
     * `useSyncExternalStore` exactly as it reads the shell's own stores.
     * @param initial - the first snapshot.
     */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        patch: (partial) => {
          value = { ...value, ...partial }
          for (const listener of [...listeners]) listener()
        }
      }
    }

    /**
     * Post one method to the plugin's host route family.
     * @param method - one of the Host half's ROUTE_KEYS.
     * @param payload - JSON body.
     * @returns the unwrapped response payload.
     */
    async function callApi(method, payload) {
      let response
      try {
        response = await fetch(`${ROUTE}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {})
        })
      } catch (error) {
        throw new Error(`无法连接宿主插件路由，请确认插件已随 Harness 启动。(${String(error?.message ?? error)})`)
      }
      let data
      try {
        data = await response.json()
      } catch {
        data = undefined
      }
      if (!response.ok || data?.ok !== true) {
        throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${response.status}`)
      }
      return data
    }

    /** Format a money amount with the currency's symbol and a useful precision. */
    function formatMoney(amount, currency) {
      const value = Number(amount)
      const safe = Number.isFinite(value) ? value : 0
      const symbol = currency === 'USD' ? '$' : '¥'
      const magnitude = Math.abs(safe)
      const digits = magnitude === 0 ? 3 : magnitude < 0.01 ? 4 : magnitude < 1 ? 3 : 2
      return `${symbol}${safe.toFixed(digits)}`
    }

    /** Format a token count compactly (1.2M) while the exact value stays in the panel. */
    function formatTokens(count) {
      const value = Number(count)
      if (!Number.isFinite(value) || value === 0) return '0'
      if (value < 1000) return String(Math.round(value))
      if (value < 1000000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}K`
      return `${(value / 1000000).toFixed(2)}M`
    }

    /** Sum every billing bucket of one tokenUsage projection. */
    function usageTotal(usage) {
      if (usage === null || usage === undefined) return 0
      return (Number(usage.uncachedInputTokens) || 0)
        + (Number(usage.cacheReadTokens) || 0)
        + (Number(usage.cacheWriteTokens) || 0)
        + (Number(usage.outputTokens) || 0)
    }

    /**
     * Share of the billed input that came back from cache, as the shell's own
     * token pill reads it: cached reads over every billed input token.
     * @param buckets - a report's bucket totals.
     * @returns the percentage, or null when there was no input at all.
     */
    function cacheHitPercent(buckets) {
      if (buckets === null || buckets === undefined) return null
      const billedInput = (Number(buckets.uncachedInputTokens) || 0)
        + (Number(buckets.cacheReadTokens) || 0)
        + (Number(buckets.cacheWriteTokens) || 0)
      if (billedInput <= 0) return null
      return ((Number(buckets.cacheReadTokens) || 0) / billedInput) * 100
    }

    /** A session id short enough for a panel row, for a subagent with no title. */
    function shortSessionId(sessionId) {
      const id = String(sessionId ?? '')
      return id.length > 8 ? id.slice(0, 8) : id
    }

    // ── icons ────────────────────────────────────────────────────────────────
    // Inline artwork keeps the pill dependency-free; every glyph is drawn in
    // `currentColor` on a 24×24 grid so it reads at 14px inside the composer.

    /** One stroked icon frame. */
    function Icon({ children, size = 16, className }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        className
      }, children)
    }

    /** A coin: the spend readout's own glyph. */
    function IconCoin(props) {
      return h(Icon, props,
        h('circle', { cx: 12, cy: 12, r: 8.5 }),
        h('path', { d: 'M12 7.4v9.2' }),
        h('path', { d: 'M14.6 9.6c0-1.2-1.1-1.9-2.6-1.9s-2.6.7-2.6 1.9 1.1 1.7 2.6 2 2.6.8 2.6 2-1.1 1.9-2.6 1.9-2.6-.7-2.6-1.9' }))
    }

    /** A warning triangle, used when the amount could not be produced. */
    function IconWarning(props) {
      return h(Icon, props,
        h('path', { d: 'M12 4.6 20.2 19H3.8L12 4.6Z' }),
        h('path', { d: 'M12 9.6v4.2' }),
        h('path', { d: 'M12 16.6v.4' }))
    }

    // ── an anchored panel ────────────────────────────────────────────────────

    /** Roughly how tall a panel gets before it scrolls; used to pick a side. */
    const PANEL_IDEAL_HEIGHT = 300

    /** Gap between the anchor and its panel, in CSS pixels. */
    const PANEL_GAP = 6

    /**
     * Where one panel goes, given the anchor and the viewport.
     *
     * The spend pill lives under the composer, i.e. against the bottom edge of the
     * window — a panel placed below it lands off-screen and looks like nothing
     * happened at all. So the side is chosen from the room actually available,
     * and the panel is capped to that room instead of overflowing it.
     *
     * @param anchorRect - `getBoundingClientRect()` of the anchor.
     * @param viewport - `{ width, height }` of the window.
     * @returns `{ side, top, bottom, right, maxHeight }` in CSS pixels.
     */
    function computePanelPosition(anchorRect, viewport) {
      const width = Number(viewport?.width) || 0
      const height = Number(viewport?.height) || 0
      const above = Math.max(0, anchorRect.top - PANEL_GAP)
      const below = Math.max(0, height - anchorRect.bottom - PANEL_GAP)
      // Prefer the roomier side, with a bias to opening upward: this panel is
      // opened from the bottom of the window, where "below" is usually nothing.
      const side = above >= below || above >= PANEL_IDEAL_HEIGHT ? 'above' : 'below'
      const room = side === 'above' ? above : below
      return {
        side,
        top: side === 'below' ? Math.round(anchorRect.bottom + PANEL_GAP) : undefined,
        bottom: side === 'above' ? Math.round(height - anchorRect.top + PANEL_GAP) : undefined,
        right: Math.max(8, Math.round(width - anchorRect.right)),
        maxHeight: Math.max(120, Math.min(PANEL_IDEAL_HEIGHT, room))
      }
    }

    /**
     * A `document.body` portal hung off one anchor, closed on an outside click,
     * Escape, a resize or a scroll.
     * @param open - whether the panel is showing.
     * @param anchorRef - the element the panel hangs from.
     * @param onClose - called when the panel should close.
     * @returns `{ target, position }`; the target is null while closed.
     */
    function useAnchoredPanel(open, anchorRef, onClose) {
      const [target, setTarget] = useState(null)
      const [position, setPosition] = useState(null)

      useEffect(() => {
        if (!open) {
          setTarget(null)
          setPosition(null)
          return undefined
        }
        const anchor = anchorRef.current
        if (anchor === null || anchor === undefined) return undefined
        setPosition(computePanelPosition(anchor.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight
        }))

        const node = document.createElement('div')
        node.dataset.dshCostPanel = ''
        document.body.append(node)
        setTarget(node)

        const onPointerDown = (event) => {
          if (anchor.contains(event.target) || node.contains(event.target)) return
          onClose()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('resize', onClose)
        // A fixed panel cannot follow a scrolling anchor, so it closes instead of
        // drifting away from the pill it belongs to.
        window.addEventListener('scroll', onClose, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('resize', onClose)
          window.removeEventListener('scroll', onClose, true)
          node.remove()
        }
      }, [open, anchorRef, onClose])

      return { target, position }
    }

    /** Render one anchored panel with the given body. */
    function AnchoredPanel({ open, anchorRef, onClose, children }) {
      const { target, position } = useAnchoredPanel(open, anchorRef, onClose)
      if (target === null || position === null) return null
      const placement = {
        right: `${position.right}px`,
        maxHeight: `${position.maxHeight}px`,
        overflowY: 'auto'
      }
      if (position.side === 'above') placement.bottom = `${position.bottom}px`
      else placement.top = `${position.top}px`
      return reactDom.createPortal(
        h('div', { [OWN_ROOT_ATTRIBUTE]: '', style: { ...styles.panelSurface, ...placement } }, children),
        target
      )
    }

    // ── the spend pill ───────────────────────────────────────────────────────

    /** One plain label/value row. */
    function DetailRow({ label, value, muted }) {
      return h('div', { style: styles.detailRow },
        h('span', { style: muted === true ? styles.detailLabelMuted : styles.detailLabel }, label),
        h('span', { style: styles.detailValue }, value))
    }

    /**
     * One billing line: what it cost, with the token count it was charged for.
     * The amount leads because that is what the panel is opened to read.
     */
    function CostLineRow({ label, amount, tokens, t }) {
      return h('div', { style: styles.detailRow },
        h('span', { style: styles.detailLabel }, label),
        h('span', { style: styles.detailValue },
          amount,
          tokens > 0
            ? h('span', { style: styles.detailTokens }, ` · ${formatTokens(tokens)} ${t('cost.tokens')}`)
            : null))
    }

    /** The label for one billing kind, so the panel and the tooltip agree. */
    function costKindLabel(kind, t) {
      const key = {
        cacheHit: 'cost.line.cacheHit',
        cacheMiss: 'cost.line.cacheMiss',
        cacheWrite: 'cost.line.cacheWrite',
        output: 'cost.line.output'
      }[kind]
      return key === undefined ? kind : t(key)
    }

    /**
     * The conversation's spend, rendered in the composer dock beside the shell's
     * token pill. It refreshes whenever the token projection moves, which is the
     * same signal the token pill itself redraws on.
     */
    function CostPill(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const sessionId = props.sessionId
      const useProjection = props.useProjection
      const state = useSyncExternalStore(engine.store.subscribe, engine.store.getSnapshot)
      const snapshot = state.snapshot
      const usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined
      const tokens = usageTotal(usage)
      const [report, setReport] = useState(null)
      const [failure, setFailure] = useState('')
      const [open, setOpen] = useState(false)
      const anchorRef = useRef(null)
      const close = useCallback(() => setOpen(false), [])

      const enabled = snapshot?.enabled === true && snapshot?.cost?.showInComposer === true
      const currency = snapshot?.cost?.currency ?? 'CNY'

      useEffect(() => {
        if (!enabled || sessionId === undefined || sessionId === '') return undefined
        let cancelled = false
        engine.cost(sessionId, `${tokens}`)
          .then((next) => {
            if (cancelled) return
            setReport(next)
            setFailure('')
          })
          .catch((error) => {
            if (cancelled) return
            setFailure(String(error?.message ?? error))
          })
        return () => { cancelled = true }
      }, [enabled, sessionId, tokens])

      if (snapshot === null || !enabled || sessionId === undefined || sessionId === '') return null
      // While the first answer is still on its way, and for a conversation with
      // nothing billable yet, the dock stays clean. A FAILURE is different: it is
      // shown. A pill that silently disappears is indistinguishable from a broken
      // plugin, and it hides the reason the amount could not be produced.
      const priced = report !== null && report.hasUsage === true
      if (!priced && failure === '') return null

      const amount = report?.amount ?? 0
      const cacheHit = cacheHitPercent(report?.buckets)
      const children = Array.isArray(report?.children) ? report.children : []
      const own = report?.own
      const summary = !priced
        ? `${t('cost.title')} · ${t('cost.unavailable')}\n${failure}`
        : [
            `${t('cost.title')} ${formatMoney(amount, currency)}`,
            children.length > 0
              ? `${t('cost.includesSubagents')} ${children.length}${report.subagentsTruncated === true ? '+' : ''}`
              : '',
            t('cost.formula'),
            report.unpricedTokens > 0 ? `${t('cost.unpriced')} ${formatTokens(report.unpricedTokens)}` : '',
            `${t('cost.priceSource')} ${report.priceLabel ?? ''}`.trim()
          ].filter(line => line !== '').join('\n')

      const panel = h('div', null,
        h('div', { style: styles.panelTitle },
          h('span', { style: styles.panelTitleIcon }, h(IconCoin, { size: 15 })),
          t('cost.title')),
        h('div', { style: styles.panelAmount }, priced ? formatMoney(amount, currency) : t('cost.unavailable')),
        h('div', { style: styles.panelSubtitle }, !priced
          ? ''
          : [
              `${t('cost.samples')} ${report.samples}`,
              `${t('cost.tokens')} ${formatTokens(report.tokens)}`,
              cacheHit === null ? '' : `${t('cost.cacheHitRate')} ${cacheHit.toFixed(1)}%`
            ].filter(part => part !== '').join(' · ')),
        // A subagent's tokens are billed to this conversation, so the headline is
        // the whole tree. Splitting it out is the only way to see where it went.
        !priced || children.length === 0 ? null : h('div', { style: styles.detailList },
          h('div', { style: styles.detailHeading }, t('cost.subagentBreakdown')),
          h(DetailRow, {
            label: t('cost.mainConversation'),
            value: formatMoney(own?.amount ?? 0, currency)
          }),
          ...children.map((child, index) => h(DetailRow, {
            key: child.sessionId ?? `child-${index}`,
            label: `${'· '.repeat(Math.max(0, Number(child.depth ?? 1) - 1))}${child.title === '' || child.title === undefined
              ? `${t('cost.subagent')} ${shortSessionId(child.sessionId)}`
              : child.title}`,
            value: formatMoney(child.amount ?? 0, currency)
          })),
          h(DetailRow, {
            label: t('cost.subagentTotal'),
            value: formatMoney(Math.max(0, amount - Number(own?.amount ?? 0)), currency)
          }),
          report.subagentsTruncated === true
            ? h('div', { style: styles.detailNote }, t('cost.subagentTruncated'))
            : null),
        !priced ? null : h('div', { style: styles.detailList },
          h('div', { style: styles.detailHeading }, t('cost.breakdown')),
          ...report.lines
            // A kind this conversation never used has nothing to explain — except
            // the three input/output lines, whose zero is itself information.
            .filter(line => line.tokens > 0 || line.kind === 'cacheMiss' || line.kind === 'cacheHit' || line.kind === 'output')
            .map(line => h(CostLineRow, {
              key: line.kind,
              t,
              label: costKindLabel(line.kind, t),
              amount: formatMoney(line.amount, currency),
              tokens: line.tokens
            })),
          report.peakSamples > 0
            ? h(DetailRow, { label: t('cost.peakSamples'), value: `${report.peakSamples} / ${report.samples}` })
            : null),
        !priced ? null : h('div', { style: styles.detailList },
          h('div', { style: styles.detailHeading }, t('cost.byModel')),
          ...report.byModel.map(entry => h(DetailRow, {
            key: `${entry.provider}/${entry.model}`,
            label: entry.model,
            value: formatMoney(entry.amount, currency)
          }))),
        !priced || report.unpricedTokens === 0 ? null : h('div', { style: styles.noticeWarn },
          `${t('cost.unpriced')} ${formatTokens(report.unpricedTokens)}${report.unpricedModels.length > 0 ? `（${report.unpricedModels.join(', ')}）` : ''}`),
        failure === '' ? null : h('div', { style: styles.noticeBad }, `${t('cost.failed')}${failure}`),
        h('div', { style: styles.panelMeta },
          `${t('cost.priceSource')} ${report?.priceLabel ?? ''}`.trim(),
          h('br'),
          `${t('cost.priceUpdated')} ${report?.priceUpdatedAt === undefined ? '' : new Date(report.priceUpdatedAt).toLocaleString()}`))

      return h('span', { style: styles.costAnchor, ref: anchorRef },
        h('button', {
          type: 'button',
          style: { ...styles.pill, ...open ? styles.pillOpen : {}, ...priced ? {} : styles.pillWarn },
          title: summary,
          'aria-label': summary,
          onClick: () => setOpen(current => !current)
        },
        priced ? h(IconCoin, { size: 14 }) : h(IconWarning, { size: 14 }),
        h('span', null, priced ? formatMoney(amount, currency) : t('cost.unavailable'))),
        h(AnchoredPanel, { open, anchorRef, onClose: close }, panel))
    }

    // ── the settings page ────────────────────────────────────────────────────

    /** Read a nested settings value with a fallback. */
    function read(object, path, fallback) {
      let current = object
      for (const key of path.split('.')) {
        if (current === null || current === undefined || typeof current !== 'object') return fallback
        current = current[key]
      }
      return current === undefined ? fallback : current
    }

    /** Write a nested settings value into a cloned draft. */
    function write(draft, path, value) {
      const keys = path.split('.')
      const next = { ...draft }
      let cursor = next
      for (let index = 0; index < keys.length - 1; index += 1) {
        const key = keys[index]
        cursor[key] = { ...(cursor[key] ?? {}) }
        cursor = cursor[key]
      }
      cursor[keys[keys.length - 1]] = value
      return next
    }

    /** One labelled switch row. */
    function SwitchRow({ label, hint, checked, onChange, disabled }) {
      return h('label', { style: styles.switchRow },
        h('input', {
          type: 'checkbox',
          checked,
          disabled: disabled === true,
          onChange: event => onChange(event.target.checked)
        }),
        h('span', null,
          h('span', { style: styles.switchLabel }, label),
          hint === undefined || hint === '' ? null : h('span', { style: styles.switchHint }, hint)))
    }

    /** One labelled text or number input row. */
    function FieldRow({ label, hint, value, onChange, type = 'text', placeholder, disabled }) {
      return h('label', { style: styles.fieldRow },
        h('span', { style: styles.fieldLabel }, label),
        h('input', {
          type,
          value,
          placeholder: placeholder ?? '',
          disabled: disabled === true,
          style: styles.input,
          onChange: event => onChange(event.target.value)
        }),
        hint === undefined || hint === '' ? null : h('span', { style: styles.fieldHint }, hint))
    }

    /** One labelled select row. */
    function SelectRow({ label, hint, value, options, onChange }) {
      return h('label', { style: styles.fieldRow },
        h('span', { style: styles.fieldLabel }, label),
        h('select', { value, style: styles.select, onChange: event => onChange(event.target.value) },
          ...options.map(option => h('option', { key: option.value, value: option.value }, option.label))),
        hint === undefined || hint === '' ? null : h('span', { style: styles.fieldHint }, hint))
    }

    /**
     * The spend settings page.
     *
     * The page edits a draft and saves it whole, so a half-typed URL or a
     * transient number never reaches the Host document.
     */
    function CostSettings(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const state = useSyncExternalStore(engine.store.subscribe, engine.store.getSnapshot)
      const snapshot = state.snapshot
      const [draft, setDraft] = useState(null)
      const [message, setMessage] = useState(null)
      const [busy, setBusy] = useState('')

      useEffect(() => {
        if (snapshot !== null && draft === null) setDraft(JSON.parse(JSON.stringify({
          enabled: snapshot.enabled,
          cost: snapshot.cost
        })))
      }, [snapshot, draft])

      if (state.loaded !== true) return h('div', { style: styles.muted }, t('loading'))
      if (snapshot === null) return h('div', { style: styles.noticeBad }, state.error)

      const model = draft ?? { enabled: snapshot.enabled, cost: snapshot.cost }
      const set = (path, value) => setDraft(write(model, path, value))
      const prices = snapshot.prices ?? {}

      const save = async () => {
        setBusy('save')
        setMessage(null)
        try {
          await engine.save(model)
          setMessage({ kind: 'ok', text: t('saved') })
        } catch (error) {
          setMessage({ kind: 'bad', text: `${t('saveFailed')}${String(error?.message ?? error)}` })
        } finally {
          setBusy('')
        }
      }

      const onRefreshPrices = async () => {
        setBusy('prices')
        setMessage(null)
        try {
          const result = await engine.refreshPrices()
          setDraft(null)
          setMessage(result.error === ''
            ? { kind: 'ok', text: t('cost.refreshed') }
            : { kind: 'bad', text: `${t('cost.refreshFailed')}${result.error}` })
        } catch (error) {
          setMessage({ kind: 'bad', text: `${t('cost.refreshFailed')}${String(error?.message ?? error)}` })
        } finally {
          setBusy('')
        }
      }

      return h('div', { style: styles.settingsRoot },
        h('div', { style: styles.header },
          h('div', null,
            h('div', { style: styles.title }, t('title')),
            h('div', { style: styles.subtitle }, t('subtitle')))),
        h('div', { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('cost.section')),
          h(SwitchRow, {
            label: t('cost.enabled'),
            hint: t('cost.enabledHint'),
            checked: read(model, 'enabled', true) === true,
            onChange: value => set('enabled', value)
          }),
          h(SwitchRow, {
            label: t('cost.inComposer'),
            hint: t('cost.inComposerHint'),
            checked: read(model, 'cost.showInComposer', true) === true,
            onChange: value => set('cost.showInComposer', value)
          }),
          h(SwitchRow, {
            label: t('cost.includeSubagents'),
            hint: t('cost.includeSubagentsHint'),
            checked: read(model, 'cost.includeSubagents', true) === true,
            onChange: value => set('cost.includeSubagents', value)
          }),
          h(SelectRow, {
            label: t('cost.currency'),
            hint: t('cost.currencyHint'),
            value: read(model, 'cost.currency', 'CNY'),
            options: [
              { value: 'CNY', label: t('cost.cny') },
              { value: 'USD', label: t('cost.usd') }
            ],
            onChange: value => set('cost.currency', value)
          }),
          h(SelectRow, {
            label: t('cost.source'),
            hint: t('cost.sourceHint'),
            value: read(model, 'cost.pricingSource', 'auto'),
            options: [
              { value: 'auto', label: t('cost.sourceAuto') },
              { value: 'deepseek-docs', label: t('cost.sourceDocs') },
              { value: 'json', label: t('cost.sourceJson') },
              { value: 'builtin', label: t('cost.sourceBuiltin') }
            ],
            onChange: value => set('cost.pricingSource', value)
          }),
          read(model, 'cost.pricingSource', 'auto') === 'json'
            ? h(FieldRow, {
                label: t('cost.url'),
                hint: t('cost.urlHint'),
                value: read(model, 'cost.pricingUrl', ''),
                placeholder: 'https://…/prices.json',
                onChange: value => set('cost.pricingUrl', value)
              })
            : null,
          h(FieldRow, {
            label: t('cost.rate'),
            hint: t('cost.rateHint'),
            type: 'number',
            value: String(read(model, 'cost.usdCny', 7.1)),
            onChange: value => set('cost.usdCny', Number(value))
          }),
          h(FieldRow, {
            label: t('cost.refreshHours'),
            hint: t('cost.refreshHoursHint'),
            type: 'number',
            value: String(read(model, 'cost.refreshHours', 168)),
            onChange: value => set('cost.refreshHours', Number(value))
          }),
          h(SwitchRow, {
            label: t('cost.autoRefresh'),
            hint: t('cost.autoRefreshHint'),
            checked: read(model, 'cost.autoRefreshPrices', true) === true,
            onChange: value => set('cost.autoRefreshPrices', value)
          }),
          h('div', { style: styles.metaList },
            h('div', null, `${t('cost.tableSource')}: ${prices.label ?? ''}`),
            h('div', null, `${t('cost.tableUpdated')}: ${prices.updatedAt === undefined ? '' : new Date(prices.updatedAt).toLocaleString()}${prices.stale === true ? ` · ${t('cost.tableStale')}` : ''}`),
            h('div', null, `${t('cost.tableModels')}: ${(prices.models ?? []).join(', ')}`),
            prices.error ? h('div', { style: styles.noticeWarn }, prices.error) : null),
          h('div', { style: styles.buttonRow },
            h('button', {
              type: 'button',
              style: styles.buttonGhost,
              disabled: busy === 'prices',
              onClick: () => { void onRefreshPrices() }
            }, busy === 'prices' ? t('cost.refreshing') : t('cost.refresh'))),
          h('div', { style: styles.hint }, t('cost.note'))),
        h('div', { style: styles.metaList },
          h('div', null, `${t('meta.version')}: ${snapshot.pluginVersion ?? ''}`),
          h('div', null, `${t('meta.settingsFile')}: ${snapshot.settingsFile ?? ''}`),
          h('div', null, `${t('meta.pricesFile')}: ${snapshot.pricesFile ?? ''}`),
          h('div', null, `${t('meta.stateDir')}: ${snapshot.stateDir ?? ''}`)),
        message === null ? null : h('div', { style: message.kind === 'ok' ? styles.ok : styles.bad }, message.text),
        h('div', { style: styles.footer },
          h('button', {
            type: 'button',
            style: styles.buttonPrimary,
            disabled: busy === 'save',
            onClick: () => { void save() }
          }, busy === 'save' ? t('saving') : t('save'))))
    }

    // ── strings and styles ───────────────────────────────────────────────────

    const styles = {
      // anchored panel
      panelSurface: {
        position: 'fixed',
        maxWidth: '340px',
        padding: '12px 14px',
        borderRadius: 'var(--dsw-radius-lg, 10px)',
        border: '1px solid var(--dsw-alias-border-l1, #3A3F47)',
        background: 'var(--dsw-alias-bg-layer-1, #1B1B1C)',
        color: 'var(--dsw-alias-label-primary, #F2F4F7)',
        boxShadow: 'var(--dsw-shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.35))',
        fontSize: '12px',
        lineHeight: '18px',
        zIndex: 2147483000
      },
      panelTitle: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '13px' },
      panelTitleIcon: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary, #C9CDD4)' },
      panelAmount: { fontSize: '20px', fontWeight: 600, margin: '6px 0 2px' },
      panelSubtitle: { color: 'var(--dsw-alias-label-tertiary, #8A9199)', marginBottom: '8px' },
      panelMeta: { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--dsw-alias-border-l1, #3A3F47)', color: 'var(--dsw-alias-label-tertiary, #8A9199)', wordBreak: 'break-all' },
      detailList: { display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '8px' },
      detailHeading: { color: 'var(--dsw-alias-label-tertiary, #8A9199)', marginTop: '2px' },
      detailRow: { display: 'flex', justifyContent: 'space-between', gap: '12px' },
      detailLabel: { color: 'var(--dsw-alias-label-secondary, #C9CDD4)' },
      detailLabelMuted: { color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      detailValue: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      detailTokens: { marginLeft: '2px', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      detailNote: { color: 'var(--dsw-alias-label-tertiary, #8A9199)', marginTop: '2px' },
      noticeWarn: { marginTop: '6px', color: 'var(--dsw-alias-state-warning-primary, #E8A33D)' },
      noticeBad: { marginTop: '6px', color: 'var(--dsw-alias-state-error-primary, #F0616D)', wordBreak: 'break-all' },
      // composer pill
      costAnchor: { display: 'inline-flex' },
      pill: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #C9CDD4)',
        font: 'inherit',
        fontSize: '12px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 6px',
        borderRadius: '999px',
        cursor: 'pointer'
      },
      pillOpen: { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.18))' },
      pillWarn: { color: 'var(--dsw-alias-state-warning-primary, #E8A33D)' },
      // settings page
      settingsRoot: { paddingBottom: '8px' },
      header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '6px' },
      title: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #F2F4F7)' },
      subtitle: { marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      section: { marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--dsw-alias-border-l1, #3A3F47)' },
      sectionTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #F2F4F7)', marginBottom: '8px' },
      hint: { marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      muted: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #34C08B)' },
      bad: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #F0616D)', wordBreak: 'break-all' },
      switchRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', marginTop: '8px', cursor: 'pointer' },
      switchLabel: { display: 'block', fontSize: '13px', color: 'var(--dsw-alias-label-primary, #F2F4F7)' },
      switchHint: { display: 'block', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      fieldRow: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '10px' },
      fieldLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #C9CDD4)' },
      fieldHint: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      input: {
        padding: '5px 8px',
        fontSize: '12px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l1, #3A3F47)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-primary, #F2F4F7)'
      },
      select: {
        padding: '5px 8px',
        fontSize: '12px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l1, #3A3F47)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-primary, #F2F4F7)'
      },
      buttonRow: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', flexWrap: 'wrap' },
      buttonPrimary: {
        appearance: 'none',
        border: 'none',
        background: 'var(--dsw-alias-brand-primary, #4C8DFF)',
        color: '#0E1116',
        font: 'inherit',
        fontSize: '12px',
        fontWeight: 600,
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        cursor: 'pointer'
      },
      buttonGhost: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l1, #3A3F47)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #C9CDD4)',
        font: 'inherit',
        fontSize: '12px',
        padding: '5px 12px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        cursor: 'pointer'
      },
      footer: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '16px', flexWrap: 'wrap' },
      metaList: { marginTop: '10px', fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-tertiary, #8A9199)', wordBreak: 'break-all' }
    }

    const zh = {
      nav: '消费金额',
      title: '对话消费金额',
      subtitle: '在输入框下方显示本对话的消费金额与明细；金额按官方标价计算，并计入该对话派生的所有子代理。',
      loading: '正在读取设置…',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，立即生效。',
      saveFailed: '保存失败：',

      'cost.section': '消费金额',
      'cost.title': '本对话消费',
      'cost.unavailable': '暂不可用',
      'cost.formula': '按官方标价、缓存命中/未命中分别计价，并区分高峰/空闲时段。',
      'cost.unpriced': '未定价 token',
      'cost.priceSource': '价格来源',
      'cost.priceUpdated': '价格更新时间',
      'cost.samples': '计费样本',
      'cost.tokens': 'Token 合计',
      'cost.breakdown': '金额明细',
      'cost.cacheHitRate': '缓存命中率',
      'cost.line.cacheMiss': '输入 · 缓存未命中',
      'cost.line.cacheHit': '输入 · 缓存命中（缓存读取）',
      'cost.line.cacheWrite': '缓存写入',
      'cost.line.output': '输出',
      'cost.peakSamples': '高峰时段样本',
      'cost.byModel': '按模型',
      'cost.includesSubagents': '含子代理',
      'cost.subagentBreakdown': '子代理分摊',
      'cost.mainConversation': '主对话',
      'cost.subagent': '子代理',
      'cost.subagentTotal': '子代理合计',
      'cost.subagentTruncated': '子代理层数过多，只统计了前几层',
      'cost.failed': '计算失败：',
      'cost.enabled': '启用消费金额',
      'cost.enabledHint': '在对话输入框下方显示本对话的消费金额。',
      'cost.inComposer': '显示在输入框下方',
      'cost.inComposerHint': '与 token 用量并排显示。',
      'cost.includeSubagents': '计入子代理费用',
      'cost.includeSubagentsHint': '把这个对话派生的每个子代理的消费都算进总额（点开可看每人分摊），最多向下三层。',
      'cost.currency': '显示货币',
      'cost.currencyHint': '官方同时公布人民币与美元标价。',
      'cost.cny': '人民币 ¥',
      'cost.usd': '美元 $',
      'cost.source': '计价来源',
      'cost.sourceHint': '“自动”会抓取 DeepSeek 官方价格页，失败时回退到插件内置价格。',
      'cost.sourceAuto': '自动（官方页面）',
      'cost.sourceDocs': '仅官方页面',
      'cost.sourceJson': '自定义 JSON 地址',
      'cost.sourceBuiltin': '仅内置价格（离线）',
      'cost.url': 'JSON 计价地址',
      'cost.urlHint': '支持插件格式，或 {模型: {cacheHit, cacheMiss, output}} 的简单格式（每百万 token）。',
      'cost.rate': '美元兑人民币汇率',
      'cost.rateHint': '仅当某个模型缺少对应货币标价时用于换算。',
      'cost.refreshHours': '价格有效期（小时）',
      'cost.refreshHoursHint': '超过这个时间就在后台重新抓取官方价格页，默认 168 小时（一周）。',
      'cost.autoRefresh': '自动刷新价格',
      'cost.autoRefreshHint': '价格过期时在后台抓取一次官方价格页。',
      'cost.refresh': '刷新价格',
      'cost.refreshing': '刷新中…',
      'cost.refreshed': '价格已更新。',
      'cost.refreshFailed': '刷新失败：',
      'cost.tableSource': '当前价格表',
      'cost.tableUpdated': '价格表时间',
      'cost.tableStale': '已过期',
      'cost.tableModels': '已定价模型',
      'cost.note': '高峰时段为 UTC 周一至周五 01:00–04:00 与 06:00–10:00，其余时间按半价（空闲时段）计费；中国法定节假日无法自动识别。缓存写入按缓存未命中价格计费。',

      'meta.version': '插件版本',
      'meta.settingsFile': '设置文件',
      'meta.pricesFile': '价格缓存',
      'meta.stateDir': '状态目录'
    }

    const en = {
      nav: 'Spend',
      title: 'Conversation spend',
      subtitle: 'Shows what this conversation cost under the composer, priced from the official list and including every subagent it delegated to.',
      loading: 'Reading settings…',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved — applied immediately.',
      saveFailed: 'Could not save: ',

      'cost.section': 'Spend',
      'cost.title': 'Conversation spend',
      'cost.unavailable': 'unavailable',
      'cost.formula': 'Priced from the official list, cache hits and misses separately, at the hour each sample was reported.',
      'cost.unpriced': 'Unpriced tokens',
      'cost.priceSource': 'Price source',
      'cost.priceUpdated': 'Prices updated',
      'cost.samples': 'Billed samples',
      'cost.tokens': 'Tokens',
      'cost.breakdown': 'Amount breakdown',
      'cost.cacheHitRate': 'Cache hit rate',
      'cost.line.cacheMiss': 'Input · cache miss',
      'cost.line.cacheHit': 'Input · cache hit (cache read)',
      'cost.line.cacheWrite': 'Cache write',
      'cost.line.output': 'Output',
      'cost.peakSamples': 'Peak-hour samples',
      'cost.byModel': 'By model',
      'cost.includesSubagents': 'incl. subagents',
      'cost.subagentBreakdown': 'Subagent share',
      'cost.mainConversation': 'This conversation',
      'cost.subagent': 'Subagent',
      'cost.subagentTotal': 'Subagents, total',
      'cost.subagentTruncated': 'Too many subagent levels; only the top ones are counted',
      'cost.failed': 'Could not price this session: ',
      'cost.enabled': 'Show the conversation spend',
      'cost.enabledHint': 'Adds the amount under the composer, next to the token pill.',
      'cost.inComposer': 'Show under the composer',
      'cost.inComposerHint': 'Rendered beside the shell’s own token usage.',
      'cost.includeSubagents': 'Include subagent spend',
      'cost.includeSubagentsHint': 'Counts every conversation this one delegated to (three levels deep at most); open the panel to see the per-subagent share.',
      'cost.currency': 'Display currency',
      'cost.currencyHint': 'DeepSeek publishes both a CNY and a USD list.',
      'cost.cny': 'CNY ¥',
      'cost.usd': 'USD $',
      'cost.source': 'Price source',
      'cost.sourceHint': '“Automatic” reads DeepSeek’s published table and falls back to the shipped one.',
      'cost.sourceAuto': 'Automatic (official page)',
      'cost.sourceDocs': 'Official page only',
      'cost.sourceJson': 'Custom JSON URL',
      'cost.sourceBuiltin': 'Shipped table only (offline)',
      'cost.url': 'JSON price URL',
      'cost.urlHint': 'Accepts this plugin’s document, or a plain {model: {cacheHit, cacheMiss, output}} map per 1M tokens.',
      'cost.rate': 'USD→CNY rate',
      'cost.rateHint': 'Only used when a model has no table in the display currency.',
      'cost.refreshHours': 'Price freshness (hours)',
      'cost.refreshHoursHint': 'After this long the official table is fetched again in the background; 168 hours by default.',
      'cost.autoRefresh': 'Refresh prices automatically',
      'cost.autoRefreshHint': 'Fetches the official table in the background once it is stale.',
      'cost.refresh': 'Refresh prices',
      'cost.refreshing': 'Refreshing…',
      'cost.refreshed': 'Prices updated.',
      'cost.refreshFailed': 'Refresh failed: ',
      'cost.tableSource': 'Current table',
      'cost.tableUpdated': 'Table updated',
      'cost.tableStale': 'stale',
      'cost.tableModels': 'Priced models',
      'cost.note': 'Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday; every other hour is billed at half price. Chinese public holidays are not detected. Cache writes are billed at the cache-miss rate.',

      'meta.version': 'Plugin version',
      'meta.settingsFile': 'Settings file',
      'meta.pricesFile': 'Price cache',
      'meta.stateDir': 'State directory'
    }

    /** Cordis services this browser half needs. */
    const inject = ['slots', 'locale']

    /**
     * The shared snapshot and API surface. The pill and the settings page read
     * the same store, so a currency change is visible immediately.
     */
    const engine = {
      store: createStore({ loaded: false, error: '', snapshot: null }),
      /** Last spend report per session, keyed by `sessionId\0tokenSignature`. */
      costCache: new Map(),

      /** Read the Host projection. */
      async load() {
        try {
          const data = await callApi('settings.get')
          engine.store.patch({ loaded: true, error: '', snapshot: data.settings })
        } catch (error) {
          engine.store.patch({ loaded: true, error: String(error?.message ?? error) })
        }
      },

      /** Persist a settings patch. The Host answers with the new projection. */
      async save(patch) {
        const current = engine.store.getSnapshot().snapshot ?? {}
        const data = await callApi('settings.update', { settings: { ...current, ...patch } })
        engine.costCache.clear()
        engine.store.patch({ error: '', snapshot: data.settings })
        return data.settings
      },

      /** Refresh the price table now. */
      async refreshPrices() {
        const data = await callApi('prices.refresh')
        engine.costCache.clear()
        await engine.load()
        return data
      },

      /** Price one session, memoised by session and token watermark. */
      async cost(sessionId, signature) {
        const key = `${sessionId}\u0000${signature}`
        const cached = engine.costCache.get(key)
        if (cached !== undefined) return cached
        const data = await callApi('cost.session', { sessionId })
        engine.costCache.set(key, data.cost)
        while (engine.costCache.size > 24) {
          const oldest = engine.costCache.keys().next()
          if (oldest.done === true) break
          engine.costCache.delete(oldest.value)
        }
        return data.cost
      }
    }

    /**
     * Mount the browser half.
     * @param ctx - the Cordis browser context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cost: dictionaries')
      ctx.effect(() => {
        void engine.load()
        return () => {}
      }, 'cost: settings load')

      ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'cost.pill',
        order: 5,
        locale: NS
      }, CostPill)), 'cost: conversation spend')

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-cost',
        order: 240,
        label: () => t('nav'),
        locale: NS
      }, CostSettings)), 'cost: settings page')
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    exports.__internals = {
      createStore,
      formatMoney,
      formatTokens,
      usageTotal,
      cacheHitPercent,
      computePanelPosition,
      costKindLabel,
      CostPill,
      CostSettings,
      engine,
      zh,
      en
    }

    return module.exports
  }
})
