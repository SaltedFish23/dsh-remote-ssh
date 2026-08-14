import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { TerminalCallView, ToolCallView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { RemoteSshManager, RemoteWorkspaceRoute } from './manager.ts'

export const name = 'dsh-remote-ssh-agent-policy'
export const inject = ['remoteSshManager', 'tools']

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
      agent.ctx.tools.restrict({ deny: [hiddenDialect] })
      if (base !== undefined && (dialect === 'bash' || route?.kind === 'remote')) {
        const described = dialect === 'bash' ? bashShellPresentation(base) : base
        const presented = route?.kind === 'remote'
          ? remoteShellPresentation(described, manager, route)
          : described
        agent.ctx.tools.register(presented)
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

const BASH_DESCRIPTION_PARAMETER = {
  type: 'string',
  required: true,
  description: 'Clear, concise description of what this command does in active voice, '
    + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
    + '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
} as const

/** Restore the ordinary Bash call summary while retaining the persistent PTY executor. */
export function bashShellPresentation(base: ToolDefinition): ToolDefinition {
  return {
    ...base,
    parameters: {
      ...base.parameters,
      description: base.parameters.description ?? BASH_DESCRIPTION_PARAMETER,
    },
    presentCall: args => {
      const view = base.presentCall?.(args)
      if (view?.card !== 'terminal' || view.description !== undefined) return view
      const description = shellDescription(args)
      return description === undefined ? view : { ...view, description }
    },
  }
}

/** Shadow only presentation; execution remains the ordinary bash tool and transparent shell. */
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

function shellDescription(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const value = (args as { description?: unknown }).description
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export default apply
