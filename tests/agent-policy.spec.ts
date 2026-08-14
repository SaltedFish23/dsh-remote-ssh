import {
  assertSupportedJsonSchema,
  defineTool,
  type JsonSchemaNode,
  type ToolCallView,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { bashShellPresentation, presentRemoteShellCall } from '../src/agent-policy.ts'
import type { RemoteWorkspaceRoute } from '../src/manager.ts'

const route = {
  kind: 'remote',
  server: { id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' },
  workspace: { id: 'project', serverId: 'devbox', remotePath: '/srv/project' },
} as RemoteWorkspaceRoute

describe('remote shell presentation', () => {
  it('restores the standard Bash description without replacing persistent execution', () => {
    const execute = async () => 'ok'
    const base = defineTool({
      name: 'bash',
      description: 'Run Bash in a persistent PTY.',
      parameters: {
        command: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'string' },
        render: () => [],
      },
      execute,
      presentCall: (args): ToolCallView => ({
        card: 'terminal',
        title: args.command,
      }),
    })

    const baseExecute = base.execute
    const presented = bashShellPresentation(base)

    expect(presented.execute).toBe(baseExecute)
    expect(presented.parameters.description).toBeUndefined()
    expect(presented.parameters.properties).toMatchObject({
      description: { type: 'string' },
    })
    expect(presented.parameters.required).toEqual(['command', 'description'])
    expect(() => assertSupportedJsonSchema(presented.parameters as JsonSchemaNode)).not.toThrow()
    expect(presented.presentCall?.({
      command: 'pwd && rg --version',
      description: 'Check current directory and rg availability',
    })).toEqual({
      card: 'terminal',
      title: 'pwd && rg --version',
      description: 'Check current directory and rg availability',
    })
  })

  it('replaces the internal session cwd with a logical workspace path', () => {
    const manager = {
      displayRemoteCwd: (_route: RemoteWorkspaceRoute, workdir?: string) => workdir === undefined
        ? '/Devbox > project'
        : `/Devbox > project/${workdir.split('/').at(-1)}`,
    }
    const terminal: ToolCallView = { card: 'terminal', title: 'pwd' }

    expect(presentRemoteShellCall(terminal, { workdir: '/srv/project/coffee' }, manager, route)).toEqual({
      card: 'terminal',
      title: 'pwd',
      cwd: '/Devbox > project/coffee',
    })
    expect(presentRemoteShellCall(terminal, {}, manager, route)).toEqual({
      card: 'terminal',
      title: 'pwd',
      cwd: '/Devbox > project',
    })
  })

  it('leaves non-terminal background cards unchanged', () => {
    const view: ToolCallView = { card: 'generic', title: 'sleep 10' }
    expect(presentRemoteShellCall(view, {}, { displayRemoteCwd: () => '/unused' }, route)).toBe(view)
  })
})
