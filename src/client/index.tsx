import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

const STATE_PATH = '/plugins/dsh-remote-ssh/state'
const WORKSPACE_PATH = '/plugins/dsh-remote-ssh/workspace'
const WORKSPACE_REMOVE_PATH = '/plugins/dsh-remote-ssh/workspace/remove'
const LOCAL_WORKSPACE_PATH = '/plugins/dsh-remote-ssh/local-workspace'
const PROBE_PATH = '/plugins/dsh-remote-ssh/probe'
const CONFIG_HOST_PATH = '/plugins/dsh-remote-ssh/ssh-config/host'
const SETTINGS_PATH = '/plugins/dsh-remote-ssh/settings'
const DIRECTORY_PATH = '/plugins/dsh-remote-ssh/directory'

interface Server { id: string; label: string; sshTarget: string; source: 'ssh-config' | 'saved'; configPath?: string; hostName?: string; user?: string; port?: number }
interface Workspace { id: string; serverId: string; remotePath: string; aliasPath: string }
interface RemoteDirectoryListing { path: string; home: string; parent?: string; entries: Array<{ name: string; path: string }> }
interface CatalogState {
  servers: Server[]
  workspaces: Workspace[]
  serverCount: number
  discoveredServerCount: number
  workspaceCount: number
  configFiles: string[]
  loadedConfigFiles: string[]
  configErrors: string[]
  customConfigFile?: string
}

const emptyCatalog: CatalogState = { servers: [], workspaces: [], serverCount: 0, discoveredServerCount: 0, workspaceCount: 0, configFiles: [], loadedConfigFiles: [], configErrors: [] }

export const name = 'dsh-remote-ssh-client'
export const inject = ['slots', 'workspaces']

/** Register the Settings section and the combined local/remote workspace flow. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'remote-ssh', order: 16, label: () => 'Remote SSH',
  }, RemoteSshSettings))

  const injected = () => ({
    listLocal: async (path?: string): Promise<RemoteDirectoryListing> => {
      const listing = await ctx.workspaces.listDirectory(path)
      const parent = listing.crumbs.length > 1 ? listing.crumbs[listing.crumbs.length - 2]?.path : undefined
      return {
        path: listing.path,
        home: listing.home,
        ...(parent === undefined ? {} : { parent }),
        entries: listing.entries.map(entry => ({ name: entry.name, path: entry.path })),
      }
    },
  })
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', inject: injected }, RemoteWorkspaceFlow)
      yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', inject: injected }, RemoteWorkspaceFlow)
    }))

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item', id: 'remote-ssh', order: 30,
  }, RemoteSshPluginCard))
}

const page: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 760 }
const card: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: 18, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const row: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }
const input: CSSProperties = { minWidth: 180, flex: '1 1 180px', padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' }
const singleLineInput: CSSProperties = { ...input, minWidth: 0, width: 520, maxWidth: '100%', height: 36, flex: '0 0 auto', boxSizing: 'border-box' }
const button: CSSProperties = { padding: '7px 13px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }
const primary: CSSProperties = { ...button, borderColor: 'var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)', color: 'white' }
const dim: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 14 }

function WorkspaceDirectoryPicker(props: {
  open: boolean
  title: string
  sourceKey: string
  initialPath: string
  list: (path?: string) => Promise<RemoteDirectoryListing>
  onPick: (path: string) => void
  onCancel: () => void
}): ReactElement | null {
  const [listing, setListing] = useState<RemoteDirectoryListing>()
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestGeneration = useRef(0)

  const browse = async (path?: string): Promise<void> => {
    const generation = ++requestGeneration.current
    setLoading(true); setError('')
    try {
      const next = await props.list(path === undefined || path.trim() === '' ? undefined : path.trim())
      if (generation !== requestGeneration.current) return
      setListing(next); setDraft(next.path)
    } catch (reason) {
      if (generation === requestGeneration.current) setError(String(reason))
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (!props.open) return
    const initial = props.initialPath.trim().startsWith('/') ? props.initialPath.trim() : undefined
    void browse(initial)
    return () => { requestGeneration.current += 1 }
  }, [props.open, props.sourceKey])

  if (!props.open) return null
  return <div style={{ position: 'fixed', inset: 0, zIndex: 1100, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.42)' }} role="dialog" aria-modal="true" aria-label={props.title}>
    <div style={{ ...card, width: 'min(620px, calc(100vw - 32px))', maxHeight: 'min(720px, calc(100vh - 32px))' }}>
      <strong>{props.title}</strong>
      <div style={row}>
        <input style={{ ...singleLineInput, flex: '1 1 320px' }} aria-label={`${props.title}路径`} value={draft} onChange={event => { setDraft(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') void browse(draft) }} />
        <button style={button} disabled={loading || draft.trim() === ''} onClick={() => { void browse(draft) }}>转到</button>
      </div>
      <div style={row}>
        <button style={button} disabled={loading || listing === undefined || listing.path === listing.home} onClick={() => { if (listing !== undefined) void browse(listing.home) }}>主目录</button>
        <button style={button} disabled={loading || listing?.parent === undefined} onClick={() => { if (listing?.parent !== undefined) void browse(listing.parent) }}>上一级</button>
        <span style={dim}>{listing?.path ?? '正在读取目录…'}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 120, maxHeight: 360, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 6 }}>
        {listing?.entries.map(entry => <button key={entry.path} style={{ ...button, border: 0, borderRadius: 6, textAlign: 'left', background: 'transparent' }} onClick={() => { void browse(entry.path) }}>📁 {entry.name}</button>)}
        {!loading && listing?.entries.length === 0 ? <p style={{ ...dim, padding: 8 }}>此目录没有子目录。</p> : null}
        {loading ? <p style={{ ...dim, padding: 8 }}>正在读取目录…</p> : null}
      </div>
      {error ? <p role="alert" style={dim}>{error}</p> : null}
      <div style={{ ...row, justifyContent: 'flex-end' }}>
        <button style={button} onClick={props.onCancel}>取消</button>
        <button style={primary} disabled={loading || listing === undefined} onClick={() => { if (listing !== undefined) props.onPick(listing.path) }}>选择当前文件夹</button>
      </div>
    </div>
  </div>
}

function RemoteSshPluginCard(): ReactElement {
  const [current, setCurrent] = useState('')
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    void request<CatalogState>(STATE_PATH).then(state => {
      const value = state.customConfigFile ?? ''
      setCurrent(value); setDraft(value); setLoading(false)
    }, () => { setFailed(true); setLoading(false) })
  }, [])
  const invalid = draft.trim() !== '' && !/^(?:[A-Za-z]:[\\/]|\/)/.test(draft.trim())
  const save = async () => {
    setSaving(true); setFailed(false)
    try {
      const result = await request<{ sshConfigFile?: string }>(SETTINGS_PATH, 'POST', { sshConfigFile: draft.trim() || undefined })
      const value = result.sshConfigFile ?? ''
      setCurrent(value); setDraft(value)
      setDirty(false)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  return <li style={{ listStyle: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, overflow: 'hidden' }}>
    <button type="button" style={{ ...button, width: '100%', border: 0, borderRadius: 0, padding: 14, textAlign: 'left' }} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
      <b>Remote SSH</b><span style={{ display: 'block', ...dim }}>OpenSSH 主机发现与远端工作区。</span>
    </button>
    {open ? <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label htmlFor="plugin-remote-ssh-config"><b>自定义 SSH 配置文件</b></label>
      <input id="plugin-remote-ssh-config" style={singleLineInput} placeholder="留空以使用用户和系统默认配置" value={draft} disabled={loading || saving} onChange={event => { setDraft(event.target.value); setDirty(true); setFailed(false) }} />
      <p style={dim}>填写绝对文件路径。设置后仅从该文件及其 Include 中发现主机。</p>
      {invalid ? <p role="alert" style={dim}>请输入绝对文件路径。</p> : null}
      {failed ? <p role="alert" style={dim}>保存失败，请检查路径和设置写权限。</p> : null}
      <div style={{ ...row, justifyContent: 'flex-end' }}>
        <button style={button} disabled={!dirty || saving} onClick={() => { setDraft(current); setDirty(false); setFailed(false) }}>放弃</button>
        <button style={primary} disabled={!dirty || invalid || loading || saving} onClick={() => { void save() }}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </div> : null}
  </li>
}

function RemoteSshSettings(): ReactElement {
  const [state, setState] = useState<CatalogState>(emptyCatalog)
  const [serverId, setServerId] = useState('')
  const [remotePath, setRemotePath] = useState('')
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false)
  const [showAddHost, setShowAddHost] = useState(false)
  const [hostCommand, setHostCommand] = useState('')
  const [configPath, setConfigPath] = useState('')
  const [message, setMessage] = useState('')
  const refresh = useCallback(async () => {
    const next = await request<CatalogState>(STATE_PATH)
    setState(next)
    setServerId(current => next.servers.some(server => server.id === current) ? current : next.servers[0]?.id ?? '')
    setConfigPath(current => next.configFiles.includes(current) ? current : next.configFiles[0] ?? '')
  }, [])
  useEffect(() => { void refresh().catch(error => { setMessage(String(error)) }) }, [refresh])

  const addHost = async (): Promise<void> => {
    await request(CONFIG_HOST_PATH, 'POST', { command: hostCommand, configPath })
    setHostCommand(''); setShowAddHost(false); setMessage('SSH 主机已写入配置文件。'); await refresh()
  }
  const addWorkspace = async (): Promise<void> => {
    await request(WORKSPACE_PATH, 'POST', { serverId, remotePath })
    setRemotePath(''); await refresh()
  }
  const probe = async (id: string): Promise<void> => {
    const result = await request<{ reachable: boolean; hostname?: string; commands?: Record<string, boolean>; error?: string }>(PROBE_PATH, 'POST', { id })
    setMessage(result.reachable
      ? `连接成功：${result.hostname ?? id}；${Object.entries(result.commands ?? {}).map(([name, yes]) => `${name} ${yes ? '✓' : '×'}`).join('，')}`
      : `连接失败：${result.error ?? '未知错误'}`)
  }

  return <section style={page}>
    <div>
      <h2 style={{ margin: 0, fontSize: 20 }}>Remote SSH</h2>
      <p style={{ ...dim, marginTop: 6 }}>SSH 配置中发现 {state.discoveredServerCount} 台主机，远端工作区 {state.workspaceCount} 个。</p>
    </div>
    {message ? <p role="status" style={dim}>{message}</p> : null}
    <div style={card}>
      <strong>服务器</strong>
      {state.servers.map(server => <div key={server.id} style={row}>
        <span style={{ flex: 1 }}>
          <b>{server.label}</b>
          {server.hostName ? <span> · {server.user ? `${server.user}@` : ''}{server.hostName}{server.port ? `:${server.port}` : ''}</span> : null}
          <small style={{ display: 'block', color: 'var(--dsw-alias-label-secondary)' }}>{server.configPath ?? '已被远端工作区保存'}</small>
        </span>
        <button style={button} onClick={() => { void probe(server.id) }}>测试</button>
      </div>)}
      {state.servers.length === 0 ? <p style={dim}>活动 SSH 配置中没有具体的 Host。</p> : null}
      <div style={row}>
        <button style={button} onClick={() => { setShowAddHost(value => !value) }}>添加新 SSH 主机…</button>
        <button style={button} onClick={() => { void refresh().then(() => { setMessage('已重新读取 SSH 配置。') }, error => { setMessage(String(error)) }) }}>刷新</button>
      </div>
      {showAddHost ? <div style={{ ...card, padding: 12 }}>
        <input style={singleLineInput} aria-label="SSH 连接命令" placeholder="ssh user@hostname -p 22" value={hostCommand} onChange={event => { setHostCommand(event.target.value) }} />
        <strong style={{ fontSize: 14 }}>选择要更新的 SSH 配置文件</strong>
        {state.configFiles.map(path => <label key={path} style={{ ...row, alignItems: 'flex-start' }}>
          <input type="radio" name="ssh-config-file" checked={configPath === path} onChange={() => { setConfigPath(path) }} />
          <span>{path}</span>
        </label>)}
        <button style={button} onClick={() => { setMessage('请在“设置 > 插件 > Remote SSH”中填写“自定义 SSH 配置文件”的绝对路径。') }}>设置 · 指定自定义配置文件</button>
        <div style={{ ...row, justifyContent: 'flex-end' }}>
          <button style={button} onClick={() => { setShowAddHost(false) }}>取消</button>
          <button style={primary} disabled={!hostCommand.trim() || !configPath} onClick={() => { void addHost().catch(error => { setMessage(String(error)) }) }}>添加</button>
        </div>
      </div> : null}
      {state.configErrors.map(error => <p key={error} style={dim}>{error}</p>)}
    </div>
    <div style={card}>
      <strong>远端工作区</strong>
      {state.workspaces.map(workspace => <div key={workspace.id} style={row}>
        <span style={{ flex: 1 }}>{state.servers.find(server => server.id === workspace.serverId)?.label ?? workspace.serverId} &gt; {workspace.remotePath}</span>
        <button style={button} onClick={() => { void request(WORKSPACE_REMOVE_PATH, 'POST', { id: workspace.id }).then(refresh) }}>移除执行映射</button>
      </div>)}
      <div style={row}>
        <select style={input} aria-label="服务器" value={serverId} onChange={event => { setServerId(event.target.value); setRemotePath(''); setShowDirectoryPicker(false) }}>
          {state.servers.map(server => <option key={server.id} value={server.id}>{server.label}</option>)}
        </select>
        <input style={input} aria-label="远端路径" placeholder="/srv/project" value={remotePath} onChange={event => { setRemotePath(event.target.value) }} />
        <button style={button} disabled={!serverId} onClick={() => { setShowDirectoryPicker(true) }}>浏览远端…</button>
        <button style={primary} disabled={!serverId || !remotePath.trim()} onClick={() => { void addWorkspace().catch(error => { setMessage(String(error)) }) }}>添加工作区</button>
      </div>
      <WorkspaceDirectoryPicker
        open={showDirectoryPicker}
        title="选择远端文件夹"
        sourceKey={`remote:${serverId}`}
        initialPath={remotePath}
        list={path => request<RemoteDirectoryListing>(DIRECTORY_PATH, 'POST', { serverId, ...(path === undefined ? {} : { path }) })}
        onCancel={() => { setShowDirectoryPicker(false) }}
        onPick={path => { setRemotePath(path); setShowDirectoryPicker(false) }}
      />
      <p style={dim}>移除映射不会删除 Workspace 或会话日志；旧会话仍可阅读，但新的工具调用会明确失败。</p>
    </div>
  </section>
}

interface FlowInjected { listLocal: (path?: string) => Promise<RemoteDirectoryListing> }

function RemoteWorkspaceFlow(props: DirectoryFlowOwnerProps & FlowInjected): ReactElement | null {
  const [state, setState] = useState<CatalogState>(emptyCatalog)
  const [serverId, setServerId] = useState('')
  const [remotePath, setRemotePath] = useState('')
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false)
  const [showLocalPicker, setShowLocalPicker] = useState(false)
  const [error, setError] = useState('')
  const wasOpen = useRef(false)
  useEffect(() => {
    if (!props.open || wasOpen.current) { wasOpen.current = props.open; return }
    wasOpen.current = true
    void request<CatalogState>(STATE_PATH).then(next => {
      setState(next); setServerId(next.servers[0]?.id ?? '')
    }, reason => { props.onError(String(reason)) })
  }, [props.open, props.onError])
  if (!props.open) return null

  const chooseLocal = async (path: string): Promise<void> => {
    const adopted = await request<{ path: string }>(LOCAL_WORKSPACE_PATH, 'POST', { path })
    props.onPicked(adopted.path)
  }
  const chooseRemote = async (): Promise<void> => {
    const created = await request<{ aliasPath: string }>(WORKSPACE_PATH, 'POST', { serverId, remotePath })
    props.onPicked(created.aliasPath)
  }

  return <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.35)' }} role="dialog" aria-modal="true" aria-label="添加工作区">
    <div style={{ ...card, width: 'min(520px, calc(100vw - 32px))' }}>
      <strong>添加工作区</strong>
      <button style={button} disabled={props.busy} onClick={() => { setShowLocalPicker(true) }}>LOCAL · 选择本机文件夹…</button>
      <WorkspaceDirectoryPicker
        open={showLocalPicker}
        title="选择本机文件夹"
        sourceKey="local"
        initialPath=""
        list={props.listLocal}
        onCancel={() => { setShowLocalPicker(false) }}
        onPick={path => { setShowLocalPicker(false); void chooseLocal(path).catch(reason => { setError(String(reason)) }) }}
      />
      <div style={row}>
        <select style={input} value={serverId} onChange={event => { setServerId(event.target.value); setRemotePath(''); setShowDirectoryPicker(false) }}>
          <option value="">选择 Remote SSH</option>
          {state.servers.map(server => <option key={server.id} value={server.id}>{server.label}</option>)}
        </select>
        <input style={input} placeholder="远端绝对路径，例如 /srv/project" value={remotePath} onChange={event => { setRemotePath(event.target.value) }} />
        <button style={button} disabled={!serverId || props.busy} onClick={() => { setShowDirectoryPicker(true) }}>浏览远端…</button>
      </div>
      <WorkspaceDirectoryPicker
        open={showDirectoryPicker}
        title="选择远端文件夹"
        sourceKey={`remote:${serverId}`}
        initialPath={remotePath}
        list={path => request<RemoteDirectoryListing>(DIRECTORY_PATH, 'POST', { serverId, ...(path === undefined ? {} : { path }) })}
        onCancel={() => { setShowDirectoryPicker(false) }}
        onPick={path => { setRemotePath(path); setShowDirectoryPicker(false) }}
      />
      {error ? <p style={dim}>{error}</p> : null}
      <div style={{ ...row, justifyContent: 'flex-end' }}>
        <button style={button} onClick={props.onCancel}>取消</button>
        <button style={primary} disabled={props.busy || !serverId || !remotePath.trim()} onClick={() => { void chooseRemote().catch(reason => { setError(String(reason)) }) }}>添加远端工作区</button>
      </div>
    </div>
  </div>
}

async function request<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value ? String(value.error) : `HTTP ${response.status}`
    throw new Error(message)
  }
  return value as T
}
