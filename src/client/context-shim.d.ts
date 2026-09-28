/**
 * Temporary 0.2.0-rc.1 migration shims for browser-side services whose
 * cordis Context declarations live in the unpublished web shell packages.
 *
 * The runtime shapes are verified against shipped artifacts:
 * - `ctx.slots.inject` / `ctx.slots.register` — exercised by
 *   @deepseek-ai/dsh-client-ui-settings-plugins@0.2.0-rc.1 (lib/client.js).
 * - `ctx.sessions.list.getSnapshot()` — session selection snapshot shape used
 *   by the open-path router; the exact 0.2.0 face lives in the web shell.
 *
 * Replace with the official declarations once upstream publishes them.
 */

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Scoped effect registration (web shell extension of the fiber lifecycle). */
    effect(setup: () => unknown, label?: string): () => void
    /** Browser slot ledger; see dsh-client-ui-slots for the full contract. */
    slots: {
      register(...args: unknown[]): unknown
      inject(name: string, factory: unknown): unknown
      entries(name: string): unknown[]
      getVersion(name: string): number
      subscribe(name: string, listener: () => void): () => void
    }
    /** Browser session selection snapshot used by the open-path router. */
    sessions: {
      list: {
        getSnapshot(): { current: string | undefined; byId: Record<string, { cwd?: string }> }
      }
    }
  }
}
