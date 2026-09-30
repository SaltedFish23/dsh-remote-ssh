import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as ClientEntry from '../src/client/index.tsx'

/**
 * The reported failure: "cannot get property \"uiWorkspace\" without inject"
 * when the LOCAL directory browser opened. `uiWorkspace` is owned by the
 * ui-workspace plugin's own fiber, so this entry may only read it from a
 * context that declares it in `inject`.
 */
function slotsStub(registrations: { name: string; options: any }[]) {
  const drain = (result: unknown): void => {
    if (result !== null && result !== undefined && Symbol.iterator in Object(result)) {
      for (const _ of result as Iterable<unknown>) void _
    }
  }
  return {
    inject: (_name: string, callback: () => unknown) => { drain(callback()) },
    register: (options: any) => {
      registrations.push({ name: options.name, options })
      return () => {}
    },
  }
}

describe('dsh-remote-ssh client entry', () => {
  it('declares every service it reads from the client context', async () => {
    expect(ClientEntry.inject).toContain('uiWorkspace')
  })

  it('lists a local directory through the sibling-owned uiWorkspace service', async () => {
    const ctx = new Context()
    const registrations: { name: string; options: any }[] = []
    const asked: (string | undefined)[] = []

    ctx.provide('slots', slotsStub(registrations))
    ctx.provide('workspaces', {})
    ctx.provide('sessions', {})
    ctx.provide('locale', {
      register: () => () => {},
      bind: () => (key: string) => key,
    })

    // ui-workspace provides this in its own fiber, exactly like the real runtime.
    await ctx.plugin({
      name: 'ui-workspace',
      inject: ['slots'],
      apply(pluginCtx) {
        pluginCtx.provide('uiWorkspace', {
          listDirectory: async (path?: string) => {
            asked.push(path)
            return {
              path: '/Users/example',
              home: '/Users/example',
              crumbs: [{ name: 'Users', path: '/Users' }, { name: 'example', path: '/Users/example' }],
              entries: [{ name: 'project', path: '/Users/example/project' }],
            }
          },
        })
      },
    }).await()

    await ctx.plugin(ClientEntry).await()

    const flow = registrations.find(entry => entry.name === 'conversation.hero.workspace.directoryFlow')
    expect(flow).toBeDefined()
    const { listLocal } = flow!.options.inject() as { listLocal: (path?: string) => Promise<unknown> }

    await expect(listLocal()).resolves.toEqual({
      path: '/Users/example',
      home: '/Users/example',
      parent: '/Users',
      entries: [{ name: 'project', path: '/Users/example/project' }],
    })
    expect(asked).toEqual([undefined])

    await ctx.fiber.dispose()
  })
})
