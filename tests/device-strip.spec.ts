import { describe, expect, it } from 'vitest'
import { ALL_DEVICES, LOCAL_DEVICE, aggregateState, deviceOfPath, resolveSelection } from '../src/client/device-strip.ts'

describe('device strip state aggregation', () => {
  it('reads an empty device as idle', () => {
    expect(aggregateState([])).toBe('idle')
  })

  it('keeps a single state unchanged', () => {
    expect(aggregateState(['connected'])).toBe('connected')
  })

  it('lets a failure paint the whole device red', () => {
    expect(aggregateState(['connected', 'failed', 'connected'])).toBe('failed')
  })

  it('ranks reconnecting above connecting', () => {
    expect(aggregateState(['connecting', 'reconnecting'])).toBe('reconnecting')
  })

  it('ranks any live link above disposed and idle', () => {
    expect(aggregateState(['disposed', 'idle', 'connected'])).toBe('connected')
    expect(aggregateState(['idle', 'disposed'])).toBe('disposed')
  })
})

describe('device strip selection resolution', () => {
  const devices = new Set([LOCAL_DEVICE, 'laptop', 'workstation'])

  it('defaults to All when nothing is stored', () => {
    expect(resolveSelection(null, devices)).toBe(ALL_DEVICES)
    expect(resolveSelection(undefined, devices)).toBe(ALL_DEVICES)
  })

  it('keeps the All choice', () => {
    expect(resolveSelection(ALL_DEVICES, devices)).toBe(ALL_DEVICES)
  })

  it('keeps a device that still exists', () => {
    expect(resolveSelection('laptop', devices)).toBe('laptop')
    expect(resolveSelection(LOCAL_DEVICE, devices)).toBe(LOCAL_DEVICE)
  })

  it('falls back to All when the remembered device vanished', () => {
    expect(resolveSelection('retired-box', devices)).toBe(ALL_DEVICES)
  })
})

describe('device attribution from the alias catalog', () => {
  const serverByAlias = new Map([
    ['/home/me/.dsh/remote-ssh/alias/abc', 'laptop'],
    ['/home/me/projects/local', 'workstation'],
  ])

  it('maps a routed alias path to its server', () => {
    expect(deviceOfPath('/home/me/.dsh/remote-ssh/alias/abc', serverByAlias)).toBe('laptop')
  })

  it('tolerates trailing separators on the workspace path', () => {
    expect(deviceOfPath('/home/me/.dsh/remote-ssh/alias/abc/', serverByAlias)).toBe('laptop')
    expect(deviceOfPath('/home/me/.dsh/remote-ssh/alias/abc\\', serverByAlias)).toBe('laptop')
  })

  it('reads unrouted paths as local', () => {
    expect(deviceOfPath('/Users/me/TempForAI', serverByAlias)).toBe(LOCAL_DEVICE)
  })

  it('does not confuse path prefixes with alias matches', () => {
    expect(deviceOfPath('/home/me/.dsh/remote-ssh/alias/abc/nested', serverByAlias)).toBe(LOCAL_DEVICE)
  })
})
