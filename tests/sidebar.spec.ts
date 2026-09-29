import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WorkspacePathMapper } from '../src/transport/runtime.ts'
import type { RemoteWorkspaceRoute } from '../src/routing/manager.ts'
import {
  buildRemoteGitCommand,
  compareListingRows,
  injectSidebarBridge,
  listRemoteDirectory,
  patchSidebarBundleFile,
  readRemoteText,
  rememberRemoteRoots,
  sidebarBridgeRoute,
} from '../src/transport/sidebar.ts'
import { describe, expect, it } from 'vitest'

const route: RemoteWorkspaceRoute = {
  kind: 'remote',
  server: { id: 'cloud', label: 'Cloud', sshTarget: 'cloud' },
  workspace: { id: 'root', serverId: 'cloud', remotePath: '/srv/project' },
  aliasPath: resolve('remote-alias'),
  mapper: new WorkspacePathMapper(resolve('remote-alias'), '/srv/project'),
}

/** Verbatim runner head of the published dsh-better-sidebar bundle. */
const BUNDLED_RUN_GIT = [
  '/** Run one git command; resolves with stdout, rejects with GitCommandError. */',
  'function runGit(cwd, args, timeoutMs = 3e4) {',
  '\tconst full = [',
  '\t\t"-C",',
  '\t\tcwd,',
  '\t\t"--no-pager",',
  '\t\t"-c",',
  '\t\t"color.ui=false",',
  '\t\t...args',
  '\t];',
  '\treturn new Promise((resolvePromise, reject) => {',
  '\t\tconst child = spawn("git", full, {',
  '\t\t\tstdio: ["ignore", "pipe", "pipe"]',
  '\t\t});',
  '\t\tchild.on("close", (code) => {',
  '\t\t\tif (code === 0) resolvePromise(stdout);',
  '\t\t\telse reject(new GitCommandError(stderr.trim() || `git exited with ${String(code)}`, "git-error", args.join(" ")));',
  '\t\t});',
  '\t});',
  '}',
].join('\n')

/** Verbatim listing head of the published bundle. */
const BUNDLED_READ_DIRECTORY = 'async function readDirectory(path, maxEntries) {\n\tlet dirents;\n\ttry {\n\t\tdirents = await readdir(path, { withFileTypes: true });\n\t} catch (error) {\n\t\tthrow new SidebarError("fs-error", `cannot list`, 400);\n\t}\n}'

/** Verbatim read head of the published bundle. */
const BUNDLED_READ_TEXT = 'async function readText(path, readLimit) {\n\tconst info = await stat(path).catch((error) => {\n\t\tthrow new SidebarError("fs-error", `cannot read`, 400);\n\t});\n\tif (info.isDirectory()) throw new SidebarError("fs-error", "is a directory", 400);\n}'

function bundledSource(): string {
  return `${BUNDLED_RUN_GIT}\n${BUNDLED_READ_DIRECTORY}\n${BUNDLED_READ_TEXT}\n`
}

describe('sidebar bridge transform', () => {
  it('injects all three published bundle functions and is idempotent', () => {
    const injected = injectSidebarBridge(bundledSource(), true)
    expect(injected).toContain('globalThis[Symbol.for("dsh-remote-ssh.sidebar-git")]?.(cwd, args, timeoutMs)')
    expect(injected).toContain('globalThis[Symbol.for("dsh-remote-ssh.sidebar-list")]?.(path, maxEntries)')
    expect(injected).toContain('globalThis[Symbol.for("dsh-remote-ssh.sidebar-read")]?.(path, readLimit)')
    expect(injected!.indexOf('const bridged')).toBeLessThan(injected!.indexOf('const full'))
    expect(injectSidebarBridge(injected!, true)).toBeUndefined()
  })

  it('injects typed source-form modules opportunistically', () => {
    const git = injectSidebarBridge('export async function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {\n\treturn ""\n}')
    expect(git).toContain('dsh-remote-ssh.sidebar-git')
    const tree = injectSidebarBridge('export async function readDirectory(path: string, maxEntries: number): Promise<SidebarFsListing> {\n\treturn { path, entries: [], truncated: false }\n}')
    expect(tree).toContain('dsh-remote-ssh.sidebar-list')
    const reader = injectSidebarBridge('async function readText(path: string, readLimit: number): Promise<{\n\tcontent: string\n}> {\n\treturn { content: "" }\n}')
    expect(reader).toContain('dsh-remote-ssh.sidebar-read')
  })

  it('injects the compact dev-loader form', () => {
    const injected = injectSidebarBridge('function runGit(cwd,args,timeoutMs=3e4){return new Promise((r)=>{r("")})}')
    expect(injected).toContain('globalThis[Symbol.for("dsh-remote-ssh.sidebar-git")]?.(cwd, args, timeoutMs)')
  })

  it('fails loud when the published bundle drifted', () => {
    expect(() => injectSidebarBridge(BUNDLED_RUN_GIT, true)).toThrow(
      'dsh-remote-ssh: stock sidebar function signature changed',
    )
  })

  it('leaves unrelated sidebar modules untouched', () => {
    const wire = 'export class SidebarError extends Error {}\nexport function writeOk() {}\n'
    expect(injectSidebarBridge(wire)).toBeUndefined()
  })
})

describe('sidebar bundle disk patch', () => {
  function scratchBundle(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-patch-'))
    const file = join(dir, 'index.js')
    writeFileSync(file, bundledSource())
    return file
  }

  it('patches once, keeps a backup, and is idempotent', () => {
    const file = scratchBundle()
    expect(patchSidebarBundleFile(file)).toBe(true)
    const patched = readFileSync(file, 'utf8')
    expect(patched).toContain('dsh-remote-ssh.sidebar-git')
    expect(patched).toContain('dsh-remote-ssh.sidebar-list')
    expect(patched).toContain('dsh-remote-ssh.sidebar-read')
    expect(readFileSync(`${file}.dsh-remote-ssh-bak`, 'utf8')).toBe(bundledSource())
    expect(patchSidebarBundleFile(file)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(patched)
  })

  it('refuses a drifted bundle without touching it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-patch-'))
    const file = join(dir, 'index.js')
    writeFileSync(file, 'function runGit(cwd, args) { return null }\n')
    expect(() => patchSidebarBundleFile(file)).toThrow('unrecognized dsh-better-sidebar bundle')
    expect(readFileSync(file, 'utf8')).toBe('function runGit(cwd, args) { return null }\n')
    expect(existsSync(`${file}.dsh-remote-ssh-bak`)).toBe(false)
  })
})

describe('sidebar bridge route resolution', () => {
  const remembered = new Map<string, RemoteWorkspaceRoute>([['/srv/parent/repo', route]])

  const remoteManager = {
    route: (_path: string | undefined, cwd: string) => {
      if (cwd === route.aliasPath || cwd.startsWith('/srv/project')) return route
      return { kind: 'local' as const }
    },
  } as unknown as Parameters<typeof sidebarBridgeRoute>[0]

  it('routes the session alias and paths inside the remote workspace', () => {
    expect(sidebarBridgeRoute(remoteManager, remembered, route.aliasPath)).toBe(route)
    expect(sidebarBridgeRoute(remoteManager, remembered, '/srv/project/src')).toBe(route)
  })

  it('pins remembered remote roots that do not exist locally', () => {
    expect(sidebarBridgeRoute(remoteManager, remembered, '/srv/parent/repo')).toBe(route)
    expect(sidebarBridgeRoute(remoteManager, remembered, '/srv/parent/repo/nested')).toBeUndefined()
  })

  it('never pins a remembered path that also exists locally', () => {
    const local = new Map<string, RemoteWorkspaceRoute>([[resolve('tests'), route]])
    expect(existsSync(resolve('tests'))).toBe(true)
    expect(sidebarBridgeRoute(remoteManager, local, resolve('tests'))).toBeUndefined()
  })

  it('leaves ordinary local directories and Windows paths to stock execution', () => {
    expect(sidebarBridgeRoute(remoteManager, remembered, resolve('local-project'))).toBeUndefined()
    expect(sidebarBridgeRoute(remoteManager, remembered, 'C:\\repo')).toBeUndefined()
    expect(sidebarBridgeRoute(remoteManager, remembered, '\\\\wsl.localhost\\distro\\repo')).toBeUndefined()
    expect(sidebarBridgeRoute(remoteManager, remembered, 'relative/path')).toBeUndefined()
  })
})

describe('sidebar git remote command', () => {
  it('builds the fully quoted redirection command', () => {
    expect(buildRemoteGitCommand('/srv/proj ect', ['status', '--porcelain=v1', '-z'], '/tmp/a b.out', '/tmp/e.err'))
      .toBe(`git '-C' '/srv/proj ect' '--no-pager' '-c' 'color.ui=false' 'status' '--porcelain=v1' '-z' < /dev/null > '/tmp/a b.out' 2> '/tmp/e.err'`)
  })

  it('single-quotes arguments containing quotes', () => {
    expect(buildRemoteGitCommand('/r', ["it's"], '/tmp/o', '/tmp/e'))
      .toBe(`git '-C' '/r' '--no-pager' '-c' 'color.ui=false' 'it'\"'\"'s' < /dev/null > '/tmp/o' 2> '/tmp/e'`)
  })

  it('refuses empty git argument lists', () => {
    expect(() => buildRemoteGitCommand('/r', [], '/tmp/o', '/tmp/e')).toThrow(
      'dsh-remote-ssh: sidebar git bridge requires at least one git argument',
    )
  })
})

describe('sidebar git root memory', () => {
  it('remembers rev-parse toplevel roots', () => {
    const remembered = new Map<string, RemoteWorkspaceRoute>()
    rememberRemoteRoots(remembered, route, ['rev-parse', '--show-toplevel'], '/srv/parent/repo\n')
    expect(remembered.get('/srv/parent/repo')).toBe(route)
  })

  it('remembers NUL-framed worktree records only', () => {
    const remembered = new Map<string, RemoteWorkspaceRoute>()
    rememberRemoteRoots(remembered, route, ['worktree', 'list', '--porcelain', '-z'], [
      'worktree /srv/parent/repo',
      'branch refs/heads/main',
      '',
      'worktree /srv/other/wt',
      'detached',
      '',
    ].join('\0'))
    expect([...remembered.keys()].sort()).toEqual(['/srv/other/wt', '/srv/parent/repo'])
  })

  it('ignores unrelated commands and relative output', () => {
    const remembered = new Map<string, RemoteWorkspaceRoute>()
    rememberRemoteRoots(remembered, route, ['status', '--porcelain=v1', '-z'], 'M  src/a.ts\0')
    rememberRemoteRoots(remembered, route, ['rev-parse', '--show-toplevel'], 'not-a-path\n')
    expect(remembered.size).toBe(0)
  })

  it('evicts the oldest entries beyond the limit', () => {
    const remembered = new Map<string, RemoteWorkspaceRoute>()
    for (let index = 0; index < 200; index += 1) {
      rememberRemoteRoots(remembered, route, ['rev-parse', '--show-toplevel'], `/srv/repo-${index}\n`)
    }
    expect(remembered.size).toBe(128)
    expect(remembered.has('/srv/repo-0')).toBe(false)
    expect(remembered.has('/srv/repo-199')).toBe(true)
  })
})

describe('sidebar explorer listing', () => {
  it('orders directories first, then case-insensitive names', () => {
    const rows = [
      { name: 'b.ts', type: 'file' },
      { name: 'Aardvark', type: 'directory' },
      { name: 'a.ts', type: 'file' },
      { name: 'Zulu', type: 'directory' },
    ]
    expect(rows.sort(compareListingRows).map(row => row.name)).toEqual(['Aardvark', 'Zulu', 'a.ts', 'b.ts'])
  })

  it('lists one remote level in remote POSIX path space', async () => {
    const manager = {
      workspaceContext: async () => ({
        remote: {
          getClient: async () => ({
            resourceList: async () => ({
              entries: [
                { name: 'src', type: 'directory' },
                { name: '.hidden', type: 'file' },
                { name: 'README.md', type: 'file' },
                { name: 'link', type: 'other' },
              ],
            }),
          }),
        },
      }),
    } as unknown as Parameters<typeof listRemoteDirectory>[0]
    const listing = await listRemoteDirectory(manager, route, route.aliasPath, 1000)
    expect(listing.path).toBe('/srv/project')
    expect(listing.truncated).toBe(false)
    expect(listing.entries.map(row => [row.name, row.isDir, row.isSymlink, row.hidden])).toEqual([
      ['src', true, false, false],
      ['.hidden', false, false, true],
      ['link', false, false, false],
      ['README.md', false, false, false],
    ])
    expect(listing.entries.every(row => row.path.startsWith('/srv/project/'))).toBe(true)
    expect(listing.entries.every(row => row.broken === false)).toBe(true)
  })

  it('flags truncation beyond the row bound', async () => {
    const manager = {
      workspaceContext: async () => ({
        remote: {
          getClient: async () => ({
            resourceList: async () => ({
              entries: [
                { name: 'a', type: 'file' },
                { name: 'b', type: 'file' },
                { name: 'c', type: 'file' },
              ],
            }),
          }),
        },
      }),
    } as unknown as Parameters<typeof listRemoteDirectory>[0]
    const listing = await listRemoteDirectory(manager, route, '/srv/project', 2)
    expect(listing.truncated).toBe(true)
    expect(listing.entries).toHaveLength(2)
  })
})

describe('sidebar editor read', () => {
  function managerWith(fs: Record<string, unknown>): Parameters<typeof readRemoteText>[0] {
    return {
      workspaceContext: async () => ({ fs }),
    } as unknown as Parameters<typeof readRemoteText>[0]
  }

  it('reads whole text files with the stock result shape', async () => {
    const fs = {
      lstat: async () => ({ type: 'file', size: 5 }),
      resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
      readBytes: async () => new TextEncoder().encode('hello'),
    }
    const result = await readRemoteText(managerWith(fs), route, '/srv/project/a.ts', 1000)
    expect(result).toEqual({ content: 'hello', truncated: false, binary: false, size: 5 })
  })

  it('truncates oversized files to the read limit', async () => {
    const fs = {
      lstat: async () => ({ type: 'file', size: 10 }),
      resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
      readByteRange: async () => new TextEncoder().encode('01234'),
    }
    const result = await readRemoteText(managerWith(fs), route, '/srv/project/big.txt', 5)
    expect(result.content).toBe('01234')
    expect(result.truncated).toBe(true)
    expect(result.size).toBe(10)
  })

  it('reports binary files with a base64 head and empty content', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])
    const fs = {
      lstat: async () => ({ type: 'file', size: bytes.byteLength }),
      resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
      readBytes: async () => bytes,
    }
    const result = await readRemoteText(managerWith(fs), route, '/srv/project/logo.png', 1000)
    expect(result.binary).toBe(true)
    expect(result.content).toBe('')
    expect(result.head).toBe(Buffer.from(bytes).toString('base64'))
  })

  it('rejects missing files and directories with duck-typed fs errors', async () => {
    const missing = { lstat: async () => undefined }
    await expect(readRemoteText(managerWith(missing), route, '/srv/project/gone', 10)).rejects.toMatchObject({ code: 'fs-error' })
    const directory = { lstat: async () => ({ type: 'directory', size: 0 }) }
    await expect(readRemoteText(managerWith(directory), route, '/srv/project', 10)).rejects.toMatchObject({ code: 'fs-error' })
  })
})
