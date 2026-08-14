import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { presentRemoteShellCall } from '../src/agent-policy.ts'
import type { RemoteWorkspaceRoute } from '../src/manager.ts'

const route = {
  kind: 'remote',
  server: { id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' },
  workspace: { id: 'project', serverId: 'devbox', remotePath: '/srv/project' },
} as RemoteWorkspaceRoute

describe('remote shell presentation', () => {
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
