/**
 * Sidebar device strip: a row of device pills ("All", "LOCAL", one per SSH
 * server) injected at the top of the workspace browser section, followed by
 * display-only filtering — selecting a device hides the workspace groups and
 * session rows that belong to other devices. No SSH connection is ever
 * touched; this is purely a view filter.
 *
 * No official slot reaches the workspace section header, so the strip is
 * injected as a foreign LAST DOM child of the WorkspaceBrowser root with a
 * negative CSS `order` — React only ever manages the children it created,
 * and an appended trailing node never becomes a reconciliation reference.
 * The root is located through the renderer's stable slot anchor
 * (`[data-slot="sidebar.workspaces"]`), never through hashed module classes.
 *
 * Filtering hides whole `groupSection` containers in grouped modes (the
 * workspace row is their direct child) and individual rows in flat mode
 * (sessions resolve to a workspace through the list store's sessionIds).
 * Search results stay unfiltered: the strip filter pauses while the browser
 * search field carries a non-empty query. The selection persists in
 * localStorage and falls back to "All" when the remembered device vanishes.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { LINK_STATE_STREAM_PATH, STATE_PATH, request, requestGetStream } from './api.ts'
import type { CatalogState, LinkStateName, LinkStateSnapshot } from './api.ts'
import { STATE_COLOR, STATE_LABEL_KEY, normalizePath } from './link-dots.ts'
import type { Translate } from './types.ts'

const STRIP_ATTRIBUTE = 'data-dsh-remote-ssh-devices'
const STYLE_ATTRIBUTE = 'data-dsh-remote-ssh-devices-style'
const HIDDEN_ATTRIBUTE = 'data-dsh-remote-ssh-hidden'
const STORAGE_KEY = 'dsh-remote-ssh:active-device'
const SLOT_SELECTOR = '[data-slot="sidebar.workspaces"]'

/** Pseudo-device ids: everything, and workspaces without a remote route. */
export const ALL_DEVICES = 'all'
export const LOCAL_DEVICE = 'local'

/** Attention order: a failure on any workspace paints the whole device red. */
const STATE_SEVERITY: Readonly<Record<LinkStateName, number>> = {
  idle: 0,
  disposed: 1,
  connected: 2,
  connecting: 3,
  reconnecting: 4,
  failed: 5,
}

/** Fold per-workspace link states into one device state (worst wins). */
export function aggregateState(states: ReadonlyArray<LinkStateName>): LinkStateName {
  let worst: LinkStateName = 'idle'
  for (const state of states) {
    if (STATE_SEVERITY[state] > STATE_SEVERITY[worst]) worst = state
  }
  return worst
}

/** Attribute a workspace path to a device; anything unrouted is local. */
export function deviceOfPath(path: string, serverByAlias: ReadonlyMap<string, string>): string {
  return serverByAlias.get(normalizePath(path)) ?? LOCAL_DEVICE
}

/**
 * Effective selection for rendering: a remembered device that disappeared
 * from the catalog reads as "All" without overwriting the stored choice.
 */
export function resolveSelection(
  stored: string | null | undefined,
  deviceIds: ReadonlySet<string>,
): string {
  if (stored === ALL_DEVICES || stored === null || stored === undefined) return ALL_DEVICES
  return deviceIds.has(stored) ? stored : ALL_DEVICES
}

const STRIP_CSS = `
[${STRIP_ATTRIBUTE}]{box-sizing:border-box;display:flex;flex:none;align-items:center;gap:2px;overflow-x:auto;overflow-y:hidden;padding:0 2px;margin:0 0 6px;scrollbar-width:none}
[${STRIP_ATTRIBUTE}]::-webkit-scrollbar{display:none}
[${STRIP_ATTRIBUTE}]>[data-pill]{flex:none;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:24px;cursor:pointer;white-space:nowrap}
[${STRIP_ATTRIBUTE}]>[data-pill]:hover{background:var(--dsw-alias-interactive-bg-hover)}
[${STRIP_ATTRIBUTE}]>[data-pill][data-selected="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
[${STRIP_ATTRIBUTE}]>[data-pill]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
[${STRIP_ATTRIBUTE}]>[data-pill]>[data-pill-dot]{width:10px;height:10px;display:inline-flex;align-items:center;justify-content:center;flex:none}
[${STRIP_ATTRIBUTE}]>[data-pill]>[data-pill-dot]>i{width:6px;height:6px;border-radius:50%;display:block}
`

interface WorkspaceListItem {
  workspaceId: string
  path: string
  sessionIds?: ReadonlyArray<string>
}

interface WorkspaceListLike {
  getSnapshot(): { items: ReadonlyArray<WorkspaceListItem> }
  subscribe(listener: () => void): () => void
}

interface PillModel {
  id: string
  label: string
  /** Undefined for the "All" pill, which carries no dot. */
  state: LinkStateName | undefined
  error?: string
}

/** Start the controller; the returned cleanup removes every trace of it. */
export function startDeviceStrip(ctx: ClientContext, t: Translate): () => void {
  const list = (ctx as unknown as { workspaces?: { list?: WorkspaceListLike } }).workspaces?.list
  if (list === undefined) {
    console.warn('dsh-remote-ssh: workspace list store is unavailable; device strip disabled')
    return () => {}
  }
  let stopped = false
  let scheduled = false
  let catalog: CatalogState | undefined
  /** Normalized alias path → serverId, merged from the catalog and stream. */
  const serverByAlias = new Map<string, string>()
  const stateByServer = new Map<string, LinkStateName>()
  const errorByServer = new Map<string, string>()
  let selected = readStored()
  let strip: HTMLElement | undefined
  let observedRoot: HTMLElement | undefined
  let pillSignature = ''
  /** Stream frames whose workspace set changed trigger one catalog refetch. */
  let lastFrameWorkspaceIds = ''
  let catalogFetch: Promise<void> | undefined

  const deviceIds = (): Set<string> =>
    new Set([LOCAL_DEVICE, ...(catalog?.servers ?? []).map(server => server.id)])

  const refreshCatalog = (): void => {
    if (catalogFetch !== undefined) return
    catalogFetch = request<CatalogState>(STATE_PATH)
      .then(state => {
        catalog = state
        for (const workspace of state.workspaces) {
          serverByAlias.set(normalizePath(workspace.aliasPath), workspace.serverId)
        }
      })
      .catch((error: unknown) => {
        console.warn('dsh-remote-ssh: catalog fetch failed', error)
      })
      .finally(() => {
        catalogFetch = undefined
        scheduleRefresh()
      })
  }

  /** One pill per device; the workspace counts come from the live list. */
  const pillModels = (): PillModel[] => {
    const pills: PillModel[] = [
      { id: ALL_DEVICES, label: t('deviceAll'), state: undefined },
      { id: LOCAL_DEVICE, label: t('deviceLocalLabel'), state: 'connected' },
    ]
    for (const server of catalog?.servers ?? []) {
      const error = errorByServer.get(server.id)
      pills.push({
        id: server.id,
        label: server.label,
        state: stateByServer.get(server.id) ?? 'idle',
        ...(error === undefined ? {} : { error }),
      })
    }
    return pills
  }

  const countByDevice = (): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const item of list.getSnapshot().items) {
      const device = deviceOfPath(item.path, serverByAlias)
      counts.set(device, (counts.get(device) ?? 0) + 1)
    }
    return counts
  }

  const refresh = (): void => {
    if (stopped) return
    const anchor = document.querySelector(SLOT_SELECTOR)
    const root = anchor?.firstElementChild as HTMLElement | null | undefined
    if (root == null) return
    ensureStrip(root)
    if (strip === undefined) return
    const rail = [...root.classList].some(name => name.endsWith('_rail'))
    strip.style.display = rail ? 'none' : ''
    renderPills()
    applyFilter(root)
  }

  const scheduleRefresh = (): void => {
    if (scheduled || stopped) return
    scheduled = true
    setTimeout(() => {
      scheduled = false
      if (!stopped) refresh()
    }, 50)
  }

  const ensureStrip = (root: HTMLElement): void => {
    if (strip === undefined) {
      strip = document.createElement('div')
      strip.setAttribute(STRIP_ATTRIBUTE, '')
      strip.setAttribute('role', 'tablist')
      strip.setAttribute('aria-label', t('deviceStripLabel'))
      pillSignature = ''
    }
    if (strip.parentElement !== root) {
      // Negative order renders the appended trailing child ABOVE the section
      // header inside the root's column flex layout.
      strip.style.order = '-1'
      root.appendChild(strip)
    }
    if (observedRoot !== root) {
      if (observedRoot !== undefined) attributeObserver.disconnect()
      attributeObserver.observe(root, { attributes: true, attributeFilter: ['class'] })
      observedRoot = root
    }
  }

  const renderPills = (): void => {
    if (strip === undefined) return
    const effective = resolveSelection(selected, deviceIds())
    const pills = pillModels()
    const signature = JSON.stringify(pills.map(pill => [pill.id, pill.label, pill.id === effective]))
    if (signature !== pillSignature) {
      pillSignature = signature
      strip.textContent = ''
      for (const pill of pills) {
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('data-pill', pill.id)
        button.setAttribute('data-selected', String(pill.id === effective))
        button.setAttribute('role', 'tab')
        button.setAttribute('aria-selected', String(pill.id === effective))
        if (pill.state !== undefined) {
          const dot = document.createElement('span')
          dot.setAttribute('data-pill-dot', '')
          dot.appendChild(document.createElement('i'))
          button.appendChild(dot)
        }
        const label = document.createElement('span')
        label.textContent = pill.label
        button.appendChild(label)
        button.addEventListener('click', () => {
          selected = pill.id
          storeSelected()
          refresh()
        })
        strip.appendChild(button)
      }
    }
    // State, count and error change without a rebuild: refresh them in place.
    const counts = countByDevice()
    const buttons = strip.querySelectorAll<HTMLElement>('[data-pill]')
    pills.forEach((pill, index) => {
      const button = buttons[index]
      if (button === undefined) return
      const core = button.querySelector<HTMLElement>('[data-pill-dot] > i')
      if (core !== null && pill.state !== undefined) {
        const color = STATE_COLOR[pill.state]
        if (core.style.background !== color) core.style.background = color
      }
      const tooltip = pillTooltip(pill, counts.get(pill.id) ?? 0)
      if (button.title !== tooltip) button.title = tooltip
    })
  }

  const pillTooltip = (pill: PillModel, count: number): string => {
    if (pill.id === ALL_DEVICES || pill.state === undefined) return pill.label
    const base = `${pill.label}: ${t(STATE_LABEL_KEY[pill.state])} · ${t('deviceWorkspaceCount', { count })}`
    return pill.error === undefined ? base : `${base}\n${pill.error}`
  }

  /** Hide/show groups and flat rows; search results stay untouched. */
  const applyFilter = (root: HTMLElement): void => {
    const effective = resolveSelection(selected, deviceIds())
    const searchInput = root.querySelector<HTMLInputElement>('input[class*="searchInput"]')
      ?? root.querySelector<HTMLInputElement>('input')
    const searchActive = (searchInput?.value ?? '').trim() !== ''
    if (effective === ALL_DEVICES || searchActive) {
      unhideAll()
      return
    }
    const deviceByWorkspaceId = new Map<string, string>()
    const deviceBySessionId = new Map<string, string>()
    for (const item of list.getSnapshot().items) {
      const device = deviceOfPath(item.path, serverByAlias)
      deviceByWorkspaceId.set(item.workspaceId, device)
      for (const sessionId of item.sessionIds ?? []) deviceBySessionId.set(sessionId, device)
    }
    for (const row of root.querySelectorAll<HTMLElement>('[data-row-key]')) {
      const key = row.getAttribute('data-row-key') ?? ''
      if (key.startsWith('workspace:')) {
        // Grouped modes: the workspace row is a direct child of its
        // groupSection, so hiding the parent collapses the whole run.
        const device = deviceByWorkspaceId.get(key.slice('workspace:'.length)) ?? LOCAL_DEVICE
        const section = row.parentElement
        if (section !== null && section !== root) {
          setHidden(section as HTMLElement, device !== effective)
        }
      } else if (key.startsWith('session:')) {
        const parent = row.parentElement
        if (parent === null) continue
        // Grouped mode hides rows through their section; only flat lists and
        // the "ungrouped sessions" section need per-row filtering here.
        if (parent.querySelector(':scope > [data-row-key^="workspace:"]') !== null) continue
        const device = deviceBySessionId.get(key.slice('session:'.length)) ?? LOCAL_DEVICE
        setHidden(row, device !== effective)
      }
    }
  }

  const setHidden = (element: HTMLElement, hidden: boolean): void => {
    if (hidden) {
      if (element.hasAttribute(HIDDEN_ATTRIBUTE)) return
      element.setAttribute(HIDDEN_ATTRIBUTE, '')
      element.style.display = 'none'
    } else if (element.hasAttribute(HIDDEN_ATTRIBUTE)) {
      element.removeAttribute(HIDDEN_ATTRIBUTE)
      element.style.display = ''
    }
  }

  const unhideAll = (): void => {
    for (const element of document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTRIBUTE}]`)) {
      setHidden(element, false)
    }
  }

  function readStored(): string {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? ALL_DEVICES
    } catch {
      return ALL_DEVICES
    }
  }

  const storeSelected = (): void => {
    try {
      localStorage.setItem(STORAGE_KEY, selected)
    } catch {
      // Private-mode storage failure must never break the strip.
    }
  }

  // Rows mount and unmount as the sidebar renders; react only to mutations
  // that carry (or remove) row-keyed elements so ordinary typing does not
  // trigger a sidebar-wide rescan.
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const relevant = [...record.addedNodes, ...record.removedNodes].some(node =>
        node instanceof HTMLElement
        && (node.hasAttribute('data-row-key') || node.querySelector('[data-row-key]') !== null))
      if (relevant) {
        scheduleRefresh()
        return
      }
    }
  })
  observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })

  // Rail ↔ wide toggles flip a class on the browser root, not its children.
  const attributeObserver = new MutationObserver(() => scheduleRefresh())

  const unsubscribeList = list.subscribe(scheduleRefresh)

  // Follow the host link-state stream, reconnecting with backoff after a
  // drop (plugin reload, host restart). Each frame is a full snapshot.
  const abort = new AbortController()
  void (async () => {
    let delay = 1000
    while (!stopped) {
      try {
        for await (const snapshot of requestGetStream<LinkStateSnapshot>(LINK_STATE_STREAM_PATH, abort.signal)) {
          stateByServer.clear()
          errorByServer.clear()
          const byServer = new Map<string, LinkStateName[]>()
          for (const link of snapshot.workspaces) {
            serverByAlias.set(normalizePath(link.aliasPath), link.serverId)
            byServer.set(link.serverId, [...(byServer.get(link.serverId) ?? []), link.state])
            if (link.error !== undefined) errorByServer.set(link.serverId, link.error)
          }
          for (const [serverId, states] of byServer) {
            stateByServer.set(serverId, aggregateState(states))
          }
          const frameIds = snapshot.workspaces.map(link => link.workspaceId).sort().join(',')
          if (catalog === undefined || frameIds !== lastFrameWorkspaceIds) refreshCatalog()
          lastFrameWorkspaceIds = frameIds
          delay = 1000
          scheduleRefresh()
        }
      } catch (error: unknown) {
        if (stopped || abort.signal.aborted) return
        console.warn('dsh-remote-ssh: link-state stream dropped', error)
      }
      if (stopped || abort.signal.aborted) return
      await sleep(delay, abort.signal)
      delay = Math.min(delay * 2, 15_000)
    }
  })()

  ensureStyle()
  refreshCatalog()
  refresh()

  return () => {
    stopped = true
    abort.abort()
    observer.disconnect()
    attributeObserver.disconnect()
    unsubscribeList()
    unhideAll()
    strip?.remove()
    document.head.querySelector(`[${STYLE_ATTRIBUTE}]`)?.remove()
  }
}

const ensureStyle = (): void => {
  if (document.head.querySelector(`[${STYLE_ATTRIBUTE}]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute(STYLE_ATTRIBUTE, '')
  style.textContent = STRIP_CSS
  document.head.appendChild(style)
}

/** Resolve false when the wait is aborted, true after the full delay. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolvePromise => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolvePromise(!signal.aborted)
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}
