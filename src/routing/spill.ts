import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { ContentEncoding } from '@microsoft/agent-host-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import type { RemoteSshManager, RemoteWorkspaceRoute } from './manager.ts'
import { routeRemoteOs } from './manager.ts'
import type { AhpClient } from '@microsoft/agent-host-protocol/client'
import { normalizeRemotePath, toNativeRemotePath } from '../transport/remote-paths.ts'
import { fileUriFromPosixPath } from '../transport/runtime.ts'

export const name = 'dsh-remote-ssh-spill'
export const inject = ['localSpillStore', 'remoteSshManager']

/** Route spill artifacts with the session execution world without exposing host files. */
export class TransparentSpillStore extends SpillStore {
  static inject = ['localSpillStore', 'remoteSshManager']

  private readonly local: SpillStore
  private readonly manager: RemoteSshManager

  constructor(ctx: Context) {
    super(ctx)
    this.local = ctx.localSpillStore
    this.manager = ctx.remoteSshManager
  }

  override async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const route = this.manager.sessionRoute(String(input.owner.sessionId))
    if (route === undefined) {
      throw new Error(`dsh-remote-ssh: no execution world is bound to spill session '${String(input.owner.sessionId)}'`)
    }
    if (route.kind === 'local') return this.local.saveText(input)
    return saveRemoteSpill(this.manager, route, input)
  }
}

/** Persist one spill through the already-authorized AHP host connection. */
export async function saveRemoteSpill(
  manager: Pick<RemoteSshManager, 'workspaceContext'>,
  route: RemoteWorkspaceRoute,
  input: SaveTextSpill,
): Promise<SpillRef> {
  const os = routeRemoteOs(route)
  const [{ remote }] = await Promise.all([manager.workspaceContext(route)])
  const client = await remote.getClient()
  const directory = remoteSpillDirectory(remote.runtimeRoot, String(input.owner.sessionId))
  const path = posix.join(directory, `${randomBytes(12).toString('hex')}-${safeSuggestedName(input.suggestedName)}`)
  await ensureRemoteDirectory(client, directory, remote.runtimeRoot)

  await client.resourceWrite({
    uri: fileUriFromPosixPath(path),
    data: input.content,
    encoding: ContentEncoding.Utf8,
    contentType: 'text/plain; charset=utf-8',
    createOnly: true,
  })
  const locator = toNativeRemotePath(os, normalizeRemotePath(os, path))
  return {
    locator: SpillLocator(locator),
    bytes: Buffer.byteLength(input.content, 'utf8'),
    retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
  }
}

/**
 * Create one remote directory (and its missing runtime-relative parents)
 * through AHP `resourceMkdir`, which works identically on POSIX and Windows
 * remotes — unlike the former `umask 077 && mkdir -p -m 700` shell round-trip.
 */
export async function ensureRemoteDirectory(client: AhpClient, directory: string, runtimeRoot: string): Promise<void> {
  const normalized = posix.normalize(directory)
  const root = posix.normalize(runtimeRoot)
  const relative = posix.relative(root, normalized)
  if (relative.startsWith('..') || posix.isAbsolute(relative)) {
    throw new Error(`dsh-remote-ssh: spill directory escapes the runtime root: ${directory}`)
  }
  let current = root
  const segments = relative.split('/').filter(Boolean)
  for (const segment of segments) {
    current = posix.join(current, segment)
    await client.resourceMkdir({ uri: fileUriFromPosixPath(current) }).catch(error => {
      if (!isAlreadyExistsError(error)) throw error
    })
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /exists|EEXIST|FileExists|conflict/i.test(message)
}

/** Stable private directory for one session inside this process's remote runtime root. */
export function remoteSpillDirectory(runtimeRoot: string, sessionId: string): string {
  const owner = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  return posix.join(runtimeRoot, 'spills', `session-${owner}`)
}

/** Suggested names are labels only; randomness supplies identity and collision resistance. */
export function safeSuggestedName(value: string): string {
  const safe = [...value].map(character => /^[A-Za-z0-9._-]$/.test(character) ? character : '_').join('')
  const bounded = safe.slice(0, 96)
  if (bounded === '' || bounded === '.' || bounded === '..') return 'result.txt'
  // Windows DOS device names (CON, NUL, COM1…) are reserved even with extensions.
  const stem = bounded.split('.', 1)[0]?.toUpperCase()
  if (stem !== undefined && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return `_${bounded}`
  return bounded
}

export default TransparentSpillStore
