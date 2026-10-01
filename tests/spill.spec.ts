import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'
import { WorkspacePathMapper } from '../src/transport/runtime.ts'
import type { RemoteSshManager, RemoteWorkspaceRoute } from '../src/routing/manager.ts'
import { remoteSpillDirectory, safeSuggestedName, saveRemoteSpill } from '../src/routing/spill.ts'
import { describe, expect, it, vi } from 'vitest'

const route: RemoteWorkspaceRoute = {
  kind: 'remote',
  server: { id: 'cloud', label: 'Cloud', sshTarget: 'cloud' },
  workspace: { id: 'project', serverId: 'cloud', remotePath: '/srv/project' },
  aliasPath: String.raw`C:\aliases\project`,
  mapper: new WorkspacePathMapper(String.raw`C:\aliases\project`, '/srv/project'),
}

describe('transparent spill store', () => {
  it('derives traversal-safe private remote names', () => {
    expect(remoteSpillDirectory('/runtime/client', 'session-a')).toMatch(/^\/runtime\/client\/spills\/session-[0-9a-f]{16}$/)
    expect(safeSuggestedName('../../secrets\\name.txt')).toBe('.._.._secrets_name.txt')
    expect(safeSuggestedName('..')).toBe('result.txt')
  })

  it('writes the complete artifact through the remote AHP connection', async () => {
    const resourceWrite = vi.fn(async () => ({}))
    const resourceMkdir = vi.fn(async () => ({}))
    const manager = {
      workspaceContext: vi.fn(async () => ({
        remote: { runtimeRoot: '/runtime/client', getClient: async () => ({ resourceWrite, resourceMkdir }) },
      })),
    } as unknown as Pick<RemoteSshManager, 'workspaceContext'>
    const input = {
      owner: { sessionId: 'session-a' },
      source: { toolName: 'job', callId: 'call-a', label: 'output' },
      suggestedName: 'job_output.txt',
      content: '完整结果\n',
    } as unknown as SaveTextSpill

    const saved = await saveRemoteSpill(manager, route, input)

    expect(resourceMkdir).toHaveBeenCalledWith(expect.objectContaining({
      uri: 'file:///runtime/client/spills',
    }))
    expect(resourceWrite).toHaveBeenCalledWith(expect.objectContaining({
      uri: expect.stringMatching(/^file:\/\/\/runtime\/client\/spills\/session-[0-9a-f]{16}\/[0-9a-f]{24}-job_output\.txt$/),
      data: input.content,
      encoding: 'utf-8',
      createOnly: true,
    }))
    expect(String(saved.locator)).toMatch(/^\/runtime\/client\/spills\/session-[0-9a-f]{16}\/[0-9a-f]{24}-job_output\.txt$/)
    expect(saved.bytes).toBe(Buffer.byteLength(input.content))
    expect(saved.retrievalHint).toContain('read with offset/limit')
  })
})
