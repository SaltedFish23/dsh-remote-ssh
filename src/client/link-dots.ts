/**
 * Sidebar workspace-row link dots: one right-aligned status dot per Remote
 * SSH workspace row, driven by the host's pushed link state machine.
 *
 * No official slot reaches the workspace group rows, so this controller
 * injects a foreign element as each row's LAST flex child — React only ever
 * manages the children it created, and an appended trailing node never
 * becomes a reconciliation reference. Rows are located through their stable
 * `data-row-key="workspace:<workspaceId>"` attribute and matched to the
 * plugin catalog through the Workspace list store (workspaceId → path) and
 * the streamed link snapshot (aliasPath → state). Local workspaces get no
 * dot; a remote workspace whose server has no live runtime shows gray.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { LINK_STATE_STREAM_PATH, requestGetStream } from './api.ts'
import type { LinkStateName, LinkStateSnapshot, WorkspaceLinkState } from './api.ts'
import type { RemoteSshLocaleKey } from './locales.ts'
import type { Translate } from './types.ts'

const DOT_ATTRIBUTE = 'data-dsh-remote-ssh-link'
const ROW_KEY_PREFIX = 'workspace:'
/** Matches the StateDot primitive: a 10px slot holding a 6px core. */
const DOT_STYLE = 'width:10px;height:10px;display:inline-flex;align-items:center;justify-content:center;flex:none;'
const CORE_STYLE = 'width:6px;height:6px;border-radius:50%;display:block;'

/** Codex semantics: starting is a warning, healing after a failure is red. */
const STATE_COLOR: Record<LinkStateName, string> = {
  connecting: 'var(--dsw-alias-state-warn-primary)',
  connected: 'var(--dsw-alias-state-success-primary)',
  reconnecting: 'var(--dsw-alias-state-error-primary)',
  failed: 'var(--dsw-alias-state-error-primary)',
  disposed: 'var(--dsw-alias-state-idle-primary)',
  idle: 'var(--dsw-alias-state-idle-primary)',
}

const STATE_LABEL_KEY: Record<LinkStateName, RemoteSshLocaleKey> = {
  connecting: 'linkStateConnecting',
  connected: 'linkStateConnected',
  reconnecting: 'linkStateReconnecting',
  failed: 'linkStateFailed',
  disposed: 'linkStateDisposed',
  idle: 'linkStateIdle',
}

interface WorkspaceListItem {
  workspaceId: string
  path: string
}

interface WorkspaceListLike {
  getSnapshot(): { items: ReadonlyArray<WorkspaceListItem> }
  subscribe(listener: () => void): () => void
}

/** Strip trailing separators so catalog and registry paths compare equal. */
function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

/** Start the controller; the returned cleanup removes every injected dot. */
export function startWorkspaceLinkDots(ctx: ClientContext, t: Translate): () => void {
  /** Latest pushed link state per normalized workspace alias path. */
  const links = new Map<string, WorkspaceLinkState>()
  const list = (ctx as unknown as { workspaces?: { list?: WorkspaceListLike } }).workspaces?.list
  if (list === undefined) {
    console.warn('dsh-remote-ssh: workspace list store is unavailable; link dots disabled')
    return () => {}
  }
  let stopped = false
  let scheduled = false

  const refresh = (): void => {
    const pathById = new Map<string, string>()
    for (const item of list.getSnapshot().items) pathById.set(item.workspaceId, normalizePath(item.path))
    for (const row of document.querySelectorAll<HTMLElement>(`[data-row-key^="${ROW_KEY_PREFIX}"]`)) {
      const workspaceId = (row.getAttribute('data-row-key') ?? '').slice(ROW_KEY_PREFIX.length)
      const path = pathById.get(workspaceId)
      const link = path === undefined ? undefined : links.get(path)
      const existing = row.querySelector<HTMLElement>(`:scope > [${DOT_ATTRIBUTE}]`)
      if (link === undefined) {
        existing?.remove()
        continue
      }
      updateDot(existing ?? createDot(row), link)
    }
  }

  const scheduleRefresh = (): void => {
    if (scheduled || stopped) return
    scheduled = true
    setTimeout(() => {
      scheduled = false
      if (!stopped) refresh()
    }, 50)
  }

  const createDot = (row: Element): HTMLElement => {
    const dot = document.createElement('span')
    dot.setAttribute(DOT_ATTRIBUTE, '')
    dot.setAttribute('role', 'img')
    dot.style.cssText = DOT_STYLE
    const core = document.createElement('i')
    core.style.cssText = CORE_STYLE
    dot.appendChild(core)
    row.appendChild(dot)
    return dot
  }

  const updateDot = (dot: HTMLElement, link: WorkspaceLinkState): void => {
    const core = dot.firstElementChild as HTMLElement | null
    const color = STATE_COLOR[link.state]
    if (core !== null && core.style.background !== color) core.style.background = color
    const label = link.error === undefined
      ? `${link.serverLabel}: ${t(STATE_LABEL_KEY[link.state])}`
      : `${link.serverLabel}: ${t(STATE_LABEL_KEY[link.state])}\n${link.error}`
    if (dot.title !== label) {
      dot.title = label
      dot.setAttribute('aria-label', label)
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

  const unsubscribeList = list.subscribe(scheduleRefresh)

  // Follow the host link-state stream, reconnecting with backoff after a
  // drop (plugin reload, host restart). Each frame is a full snapshot.
  const abort = new AbortController()
  void (async () => {
    let delay = 1000
    while (!stopped) {
      try {
        for await (const snapshot of requestGetStream<LinkStateSnapshot>(LINK_STATE_STREAM_PATH, abort.signal)) {
          links.clear()
          for (const link of snapshot.workspaces) links.set(normalizePath(link.aliasPath), link)
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

  refresh()

  return () => {
    stopped = true
    abort.abort()
    observer.disconnect()
    unsubscribeList()
    for (const dot of document.querySelectorAll(`[${DOT_ATTRIBUTE}]`)) dot.remove()
  }
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
