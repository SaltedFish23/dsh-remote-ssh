import { posix } from 'node:path'

/**
 * Operating system family of one SSH remote host's execution world.
 *
 * `'windows'` remotes keep a POSIX-shaped *internal* canonical path space —
 * `C:\Users\me\proj` is represented as `/C:/Users/me/proj`, a UNC share as
 * `//server/share` — so every existing `posix.*` join/compare keeps working
 * on internal strings while native spellings are accepted at input
 * boundaries and rendered at display boundaries. The drive colon encodes to
 * `%3A` exactly like the file URIs a Windows VS Code Agent Host emits.
 */
export type RemoteOs = 'posix' | 'windows'

/** Windows-shaped native absolute input: `C:\…`, `C:/…`, `C:`, or UNC `\\server\share`. */
export function looksLikeWindowsNativePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path) || /^\\\\/.test(path)
}

/** Canonical internal Windows form: `/C:/Users/me`, `/C:`, or `//server/share`. */
export function looksLikeWindowsInternalPath(path: string): boolean {
  return /^\/[A-Za-z]:(?:\/|$)/.test(path) || /^\/\//.test(path)
}

/** Fold any accepted Windows spelling into the internal `/`-rooted form. */
export function toInternalWindowsPath(path: string): string {
  const nativeDrive = /^([A-Za-z]):(.*)$/.exec(path)
  if (nativeDrive !== null) {
    return `/${nativeDrive[1]!.toUpperCase()}:${nativeDrive[2]}`.replaceAll('\\', '/')
  }
  const internalDrive = /^\/([A-Za-z]):(.*)$/.exec(path)
  if (internalDrive !== null) {
    return `/${internalDrive[1]!.toUpperCase()}:${internalDrive[2]}`
  }
  return path.replaceAll('\\', '/')
}

/** Normalize one remote path into the internal canonical form for {@link os}. */
export function normalizeRemotePath(os: RemoteOs, path: string): string {
  if (os === 'posix') return posix.normalize(path)
  const folded = toInternalWindowsPath(path)
  if (folded.startsWith('//')) {
    // posix.normalize collapses a leading `//`; UNC shares must keep theirs.
    const segments = folded.slice(2).split('/').filter(Boolean)
    const normalized = posix.normalize(`/${segments.join('/')}`)
    return `/${normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized}`
  }
  const normalized = posix.normalize(folded)
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/** Render an internal canonical path as the native spelling the OS shows users. */
export function toNativeRemotePath(os: RemoteOs, path: string): string {
  if (os === 'posix') return path
  if (/^\/[A-Za-z]:$/.test(path)) return `${path[1]}:\\`
  if (/^\/[A-Za-z]:/.test(path)) return path.slice(1).replaceAll('/', '\\')
  return path.replaceAll('/', '\\')
}

/** Comparison key for remote path maps: NTFS folds case, POSIX stays exact. */
export function remotePathKey(os: RemoteOs, path: string): string {
  return os === 'windows' ? normalizeRemotePath(os, path).toLowerCase() : posix.normalize(path)
}

/** Whether an input is an absolute remote path in either accepted spelling. */
export function isRemoteAbsolutePath(os: RemoteOs, path: string): boolean {
  if (os === 'posix') {
    return posix.isAbsolute(path) && !looksLikeWindowsNativePath(path) && !path.startsWith('\\\\')
  }
  return looksLikeWindowsNativePath(path) || posix.isAbsolute(path)
}

/** Resolve a possibly-relative remote input against an internal-form base. */
export function resolveRemotePath(os: RemoteOs, base: string, input: string): string {
  if (os === 'posix') return posix.resolve(base, input)
  return posix.resolve(toInternalWindowsPath(base), toInternalWindowsPath(input))
}

/**
 * Relative path from {@link from} to {@link to} in internal form; an escape
 * (`..`-prefixed, POSIX-style) is returned when {@link to} lies outside.
 * Windows compares case-insensitively and cross-drive escapes fold to `../`.
 */
export function remoteRelativePath(os: RemoteOs, from: string, to: string): string {
  const base = normalizeRemotePath(os, from)
  const target = normalizeRemotePath(os, to)
  if (os === 'posix') return posix.relative(base, target)
  const loweredBase = base.toLowerCase()
  const loweredTarget = target.toLowerCase()
  if (loweredBase === loweredTarget) return ''
  if (remoteRootOf('windows', base).toLowerCase() !== remoteRootOf('windows', target).toLowerCase()) return `..${target}`
  if (!loweredTarget.startsWith(`${loweredBase}/`)) return `..${target}`
  return target.slice(base.length + 1)
}

/** Join internal-form fragments; Windows inputs are folded before joining. */
export function joinRemotePath(os: RemoteOs, ...parts: string[]): string {
  if (os === 'posix') return posix.join(...parts)
  return posix.join(...parts.map(part => part.replaceAll('\\', '/')))
}

/** Drive root (`/C:/`) or UNC share root of an internal Windows path; `/` for POSIX. */
export function remoteRootOf(os: RemoteOs, path: string): string {
  if (os === 'posix') return '/'
  const normalized = normalizeRemotePath(os, path)
  const drive = /^\/[A-Za-z]:/.exec(normalized)
  if (drive !== null) return drive[0].endsWith('/') ? drive[0] : `${drive[0]}/`
  if (normalized.startsWith('//')) {
    const segments = normalized.split('/').filter(Boolean)
    return segments.length >= 2 ? `//${segments[0]}/${segments[1]}/` : normalized
  }
  return '/'
}

/** Whether one internal-form remote path is a filesystem root with no parent. */
export function isRemoteRoot(os: RemoteOs, path: string): boolean {
  const normalized = normalizeRemotePath(os, path)
  if (os === 'posix') return normalized === '/'
  if (/^\/[A-Za-z]:\/?$/.test(normalized)) return true
  if (normalized.startsWith('//')) return normalized.split('/').filter(Boolean).length <= 2
  return false
}

/** Infer the remote OS from an AHP `defaultDirectory`-style file URI. */
export function remoteOsFromFileUri(uri: string): RemoteOs {
  try {
    const parsed = new URL(uri)
    if (parsed.protocol !== 'file:') return 'posix'
    return looksLikeWindowsInternalPath(decodeURIComponent(parsed.pathname)) ? 'windows' : 'posix'
  } catch {
    return 'posix'
  }
}

/** Combine an optional recorded OS with the stored remotePath spelling. */
export function deriveRemoteOs(remoteOs: RemoteOs | undefined, remotePath: string): RemoteOs {
  if (remoteOs !== undefined) return remoteOs
  return looksLikeWindowsNativePath(remotePath) || looksLikeWindowsInternalPath(remotePath) ? 'windows' : 'posix'
}

/** Case/separator-insensitive key for comparing two remote paths of unknown OS. */
export function remotePathKeyAuto(path: string): string {
  return remotePathKey(deriveRemoteOs(undefined, path), path)
}
