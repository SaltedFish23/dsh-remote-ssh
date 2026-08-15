import { describe, expect, it } from 'vitest'
import { buildDshBackendCommand, DEFAULT_DSH_BACKEND_PORT } from '../src/backend.ts'

describe('full Backend SSH bootstrap', () => {
  it('starts the stable dsh-host instance and keeps the same SSH session attached', () => {
    const command = buildDshBackendCommand(DEFAULT_DSH_BACKEND_PORT)
    expect(command).toContain(`--instance dsh-remote-ssh --port ${String(DEFAULT_DSH_BACKEND_PORT)}`)
    expect(command).toContain('DSH_REMOTE_BACKEND_READY')
    expect(command).toContain('while IFS= read -r dsh_control')
    expect(command).not.toContain('--replace')
  })

  it('rejects ports that cannot be forwarded', () => {
    expect(() => buildDshBackendCommand(0)).toThrow(/invalid Backend port/)
    expect(() => buildDshBackendCommand(65536)).toThrow(/invalid Backend port/)
  })
})
