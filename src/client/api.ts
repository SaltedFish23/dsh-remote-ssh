export const STATE_PATH = '/plugins/dsh-remote-ssh/state'
export const LINK_STATE_PATH = '/plugins/dsh-remote-ssh/link-state'
export const LINK_STATE_STREAM_PATH = '/plugins/dsh-remote-ssh/link-state/stream'
export const WORKSPACE_PATH = '/plugins/dsh-remote-ssh/workspace'
export const WORKSPACE_REMOVE_PATH = '/plugins/dsh-remote-ssh/workspace/remove'
export const LOCAL_WORKSPACE_PATH = '/plugins/dsh-remote-ssh/local-workspace'
export const PROBE_PATH = '/plugins/dsh-remote-ssh/probe'
export const CONFIG_HOST_PATH = '/plugins/dsh-remote-ssh/ssh-config/host'
export const SETTINGS_PATH = '/plugins/dsh-remote-ssh/settings'
export const DIRECTORY_PATH = '/plugins/dsh-remote-ssh/directory'
export const OPEN_FILE_PATH = '/plugins/dsh-remote-ssh/open-file'

export type BackendConnectEvent =
  | { type: 'progress'; stage: string }
  | { type: 'ready'; url: string; localPort: number; remotePort: number }
  | { type: 'error'; error: string }

export type OpenFileMode = 'auto' | 'vscode' | 'cursor' | 'windsurf' | 'vscodium' | 'custom' | 'download'

export interface Server {
  id: string
  label: string
  sshTarget: string
  source: 'ssh-config' | 'saved'
  configPath?: string
  hostName?: string
  user?: string
  port?: number
  remoteOs?: 'posix' | 'windows'
}

export interface Workspace {
  id: string
  serverId: string
  remotePath: string
  aliasPath: string
}

export interface RemoteDirectoryListing {
  path: string
  home: string
  parent?: string
  entries: Array<{ name: string; path: string }>
}

export interface CatalogState {
  servers: Server[]
  workspaces: Workspace[]
  serverCount: number
  discoveredServerCount: number
  workspaceCount: number
  configFiles: string[]
  loadedConfigFiles: string[]
  configErrors: string[]
  customConfigFile?: string
  openFileMode: OpenFileMode
  openFileEditorPath?: string
}

/** Transparent-plane link states; `idle` means never connected this process. */
export type LinkStateName = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disposed' | 'idle'

/** Sidebar-facing link state for one remote workspace row. */
export interface WorkspaceLinkState {
  workspaceId: string
  serverId: string
  serverLabel: string
  aliasPath: string
  state: LinkStateName
  error?: string
}

export interface LinkStateSnapshot {
  workspaces: WorkspaceLinkState[]
}

export const emptyCatalog: CatalogState = {
  servers: [],
  workspaces: [],
  serverCount: 0,
  discoveredServerCount: 0,
  workspaceCount: 0,
  configFiles: [],
  loadedConfigFiles: [],
  configErrors: [],
  openFileMode: 'auto',
}

export async function request<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value
      ? String(value.error)
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return value as T
}

/** Read newline-delimited progress from a long-running local plugin route. */
export async function* requestStream<T>(path: string, body: unknown): AsyncGenerator<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/x-ndjson', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
  yield* readNdjson<T>(response)
}

/** Follow a long-lived GET route pushing newline-delimited snapshots. */
export async function* requestGetStream<T>(path: string, signal?: AbortSignal): AsyncGenerator<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/x-ndjson' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
  yield* readNdjson<T>(response)
}

/** Decode one JSON value per line until the stream ends or is cancelled. */
async function* readNdjson<T>(response: Response): AsyncGenerator<T> {
  if (response.body === null) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let boundary: number
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary).trim()
        buffer = buffer.slice(boundary + 1)
        if (line !== '') yield JSON.parse(line) as T
      }
      if (done) break
    }
    if (buffer.trim() !== '') yield JSON.parse(buffer) as T
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
