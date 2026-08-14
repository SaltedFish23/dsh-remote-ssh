import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { TerminalCallView, ToolCallView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { RemoteSshManager, RemoteWorkspaceRoute } from './manager.ts'

export const name = 'dsh-remote-ssh-agent-policy'
export const inject = ['remoteSshManager', 'systemPrompt', 'tools']

/** Bind each live Agent to one execution world and expose only its native shell dialect. */
export function apply(ctx: Context): void {
  const manager = ctx.remoteSshManager

  ctx.on('agent/created', ({ agent }) => {
    const sessionId = String(agent.session.header.id)
    const cwd = agent.session.header.cwd
    const route = manager.bindSession(sessionId, agent, cwd)
    const dialect = manager.dialectFor(cwd)
    const hiddenDialect = dialect === 'bash' ? 'pwsh' : 'bash'
    const base = ctx.tools.get(dialect, agent)

    try {
      if (route?.kind === 'remote') installRemoteWorkspacePrompt(agent.ctx, route)
      agent.ctx.tools.restrict({ deny: [hiddenDialect] })
      if (base !== undefined && route?.kind === 'remote') {
        agent.ctx.tools.register(remoteShellPresentation(base, manager, route))
      }
    } catch (error) {
      manager.unbindSession(sessionId, agent)
      throw error
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    ctx.remoteSshManager.unbindSession(String(agent.session.header.id), agent)
  })
}

/** Replace the host-only Workspace alias with the remote execution cwd. */
export function installRemoteWorkspacePrompt(ctx: Context, route: RemoteWorkspaceRoute): void {
  ctx.systemPrompt.variable('cwd', () => route.workspace.remotePath)
  ctx.systemPrompt.section({
    name: 'remote-ssh:execution-world',
    order: -10,
    text: 'This session runs in a Remote SSH workspace. All filesystem and shell tools operate '
      + 'on that remote host, using POSIX paths.',
  })
}

/** Shadow only presentation; execution remains the official transparent shell tool. */
export function remoteShellPresentation(
  base: ToolDefinition,
  manager: RemoteSshManager,
  route: RemoteWorkspaceRoute,
): ToolDefinition {
  return {
    ...base,
    presentCall: args => presentRemoteShellCall(base.presentCall?.(args), args, manager, route),
  }
}

export function presentRemoteShellCall(
  view: ToolCallView | undefined,
  args: unknown,
  manager: Pick<RemoteSshManager, 'displayRemoteCwd'>,
  route: RemoteWorkspaceRoute,
): ToolCallView | undefined {
  if (view?.card !== 'terminal') return view
  const workdir = shellWorkdir(args)
  try {
    return { ...view, cwd: manager.displayRemoteCwd(route, workdir) } satisfies TerminalCallView
  } catch {
    // Presentation is replayed from durable logs and must remain total even if
    // an old/malformed workdir can no longer be mapped.
    return { ...view, cwd: manager.displayRemoteCwd(route) } satisfies TerminalCallView
  }
}

function shellWorkdir(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const value = (args as { workdir?: unknown }).workdir
  return typeof value === 'string' ? value : undefined
}

export default apply
