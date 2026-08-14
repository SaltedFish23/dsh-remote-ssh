import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

declare module '@deepseek-ai/cordis' {
  interface Context {
    localFs: FileSystem
    localSubprocess: SubprocessRuntime
  }
}

/** Capture isolated local providers under names the root routers can consume. */
export const name = 'remote-ssh-local-bridge'
export const inject = ['fs', 'subprocess']

/** Publish isolated local providers without changing their implementation. */
export function apply(ctx: Context): void {
  ctx.provide('localFs', ctx.fs)
  ctx.provide('localSubprocess', ctx.subprocess)
}
