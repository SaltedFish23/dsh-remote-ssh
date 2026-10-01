import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, Fiber, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  deriveRemoteOs,
  isRemoteAbsolutePath,
  isRemoteRoot,
  looksLikeWindowsInternalPath,
  looksLikeWindowsNativePath,
  normalizeRemotePath,
  remoteOsFromFileUri,
  remotePathKey,
  remoteRelativePath,
  remoteRootOf,
  resolveRemotePath,
  toNativeRemotePath,
} from '../src/transport/remote-paths.ts'
import {
  buildPowerShellInteractiveScript,
  buildRemoteOsProbeCommand,
  buildPowerShellProcessScript,
  buildPowerShellStdinWriterScript,
  encodePowerShell,
  powerShellCommand,
  quotePowerShell,
  quoteWindowsArgument,
} from '../src/transport/powershell.ts'
import {
  WorkspacePathMapper,
  buildEmbeddedAgentHostCommand,
  buildListEmbeddedAgentHostsCommand,
  buildReapEmbeddedAgentHostCommand,
  buildRemoteAgentHostCommand,
} from '../src/transport/runtime.ts'
import { buildTerminalInvocation } from '../src/transport/shell.ts'
import {
  buildRemoteInteractiveCommand,
  buildRemoteProcessCommand,
} from '../src/routing/subprocess.ts'
import { buildRemoteGitCommand } from '../src/transport/sidebar.ts'
import { buildPosixProbeCommand, buildWindowsProbeCommand } from '../src/profiles/web.ts'
import RemoteSshManager from '../src/routing/manager.ts'
import { parseSshWorkspaceUri } from '../src/profiles/tui.ts'

function decodePowerShell(line: string): string {
  const payload = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(line)?.[1]
  if (payload === undefined) throw new Error(`not an encoded PowerShell invocation: ${line.slice(0, 120)}`)
  return Buffer.from(payload, 'base64').toString('utf16le')
}

describe('windows remote path space', () => {
  it('folds native and internal Windows spellings onto one canonical form', () => {
    expect(looksLikeWindowsNativePath('C:\\Users\\me')).toBe(true)
    expect(looksLikeWindowsNativePath('C:/Users/me')).toBe(true)
    expect(looksLikeWindowsNativePath('\\\\server\\share')).toBe(true)
    expect(looksLikeWindowsNativePath('/srv/project')).toBe(false)
    expect(looksLikeWindowsInternalPath('/C:/Users/me')).toBe(true)
    expect(looksLikeWindowsInternalPath('/srv/project')).toBe(false)
    expect(normalizeRemotePath('windows', 'c:\\users\\me\\proj')).toBe('/C:/users/me/proj')
    expect(normalizeRemotePath('windows', 'C:/Users/me/proj')).toBe('/C:/Users/me/proj')
    expect(normalizeRemotePath('windows', '/c:/users/me/proj/')).toBe('/C:/users/me/proj')
    expect(toNativeRemotePath('windows', '/C:/Users/me/proj')).toBe('C:\\Users\\me\\proj')
    expect(toNativeRemotePath('windows', '/C:/')).toBe('C:\\')
    expect(toNativeRemotePath('windows', '//server/share/x')).toBe('\\\\server\\share\\x')
    expect(normalizeRemotePath('posix', '/srv/project/')).toBe('/srv/project/')
  })

  it('keys, roots, and containment follow Windows semantics', () => {
    expect(remotePathKey('windows', '/C:/Users/me')).toBe(remotePathKey('windows', 'c:\\users\\ME'))
    expect(remotePathKey('posix', '/Srv')).toBe('/Srv')
    expect(remoteRootOf('windows', '/C:/Users/me')).toBe('/C:/')
    expect(remoteRootOf('windows', '//server/share/x')).toBe('//server/share/')
    expect(remoteRootOf('posix', '/a/b')).toBe('/')
    expect(isRemoteRoot('windows', '/C:/')).toBe(true)
    expect(isRemoteRoot('windows', 'C:\\')).toBe(true)
    expect(isRemoteRoot('windows', '/C:/Users')).toBe(false)
    expect(isRemoteRoot('posix', '/')).toBe(true)
    expect(remoteRelativePath('windows', '/C:/a/b', '/c:/A/B/C/file.ts')).toBe('C/file.ts')
    expect(remoteRelativePath('windows', '/C:/a', '/D:/b')).toBe('../D:/b')
    expect(remoteRelativePath('posix', '/a/b', '/a')).toBe('..')
    expect(resolveRemotePath('windows', '/C:/proj', 'src\\main.ts')).toBe('/C:/proj/src/main.ts')
    expect(isRemoteAbsolutePath('windows', 'C:\\x')).toBe(true)
    expect(isRemoteAbsolutePath('posix', 'C:\\x')).toBe(false)
    expect(isRemoteAbsolutePath('posix', '\\\\srv\\share')).toBe(false)
  })

  it('infers the remote OS from stored paths and AHP file URIs', () => {
    expect(deriveRemoteOs(undefined, 'C:\\proj')).toBe('windows')
    expect(deriveRemoteOs(undefined, '/C:/proj')).toBe('windows')
    expect(deriveRemoteOs('posix', 'C:\\proj')).toBe('posix')
    expect(deriveRemoteOs(undefined, '/srv/proj')).toBe('posix')
    expect(remoteOsFromFileUri('file:///c%3A/Users/me')).toBe('windows')
    expect(remoteOsFromFileUri('file:///home/me')).toBe('posix')
  })
})

describe('windows remote shell dialect', () => {
  it('quotes PowerShell literals and Windows process arguments', () => {
    expect(quotePowerShell("a'b")).toBe("'a''b'")
    expect(() => quotePowerShell('a\0b')).toThrow(/NUL/)
    expect(quoteWindowsArgument('plain')).toBe('plain')
    expect(quoteWindowsArgument('')).toBe('""')
    expect(quoteWindowsArgument('with space')).toBe('"with space"')
    expect(quoteWindowsArgument('say "hi"')).toBe('"say \\"hi\\""')
    expect(quoteWindowsArgument('C:\\path\\')).toBe('C:\\path\\')
  })

  it('encodes scripts into default-shell-proof invocations', () => {
    const line = powerShellCommand("Write-Output 'hi'")
    expect(line).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/)
    expect(decodePowerShell(line)).toBe("Write-Output 'hi'")
    expect(encodePowerShell('ü')).toBe(Buffer.from('ü', 'utf16le').toString('base64'))
  })

  it('builds byte-exact process scripts with file redirects and pipes', () => {
    const script = buildPowerShellProcessScript({
      fileName: 'git',
      args: ['-C', 'C:\\my repo', 'status'],
      env: { GIT_OPTIONAL_LOCKS: '0', GONE: undefined },
      stdin: { kind: 'file', path: 'C:\\in.bin' },
      stdoutPath: 'C:\\out.bin',
      stderrPath: 'C:\\err.bin',
    })
    expect(script).toContain("$psi.FileName = 'git'")
    expect(script).toContain('-C "C:\\my repo" status')
    expect(script).toContain("$psi.EnvironmentVariables['GIT_OPTIONAL_LOCKS'] = '0'")
    expect(script).toContain("$psi.EnvironmentVariables.Remove('GONE')")
    expect(script).toContain("OpenRead('C:\\in.bin')")
    expect(script).toContain("Create('C:\\out.bin')")
    expect(script).toContain('exit $p.ExitCode')

    const piped = buildPowerShellProcessScript({
      fileName: 'node',
      stdin: { kind: 'pipe', name: 'dsh-ssh-abc' },
    })
    expect(piped).toContain('NamedPipeClientStream')
    expect(piped).toContain("'dsh-ssh-abc'")
    expect(piped).not.toContain('RedirectStandardOutput')
  })

  it('builds the named-pipe stdin writer with the shared line protocol', () => {
    const script = buildPowerShellStdinWriterScript('dsh-ssh-abc', '__DSH_STDIN_EOF_x__')
    expect(script).toContain('NamedPipeServerStream')
    expect(script).toContain('[Convert]::FromBase64String($line)')
    expect(script).toContain("-eq '__DSH_STDIN_EOF_x__'")
  })

  it('builds interactive invocations that never hit the default shell', () => {
    const script = buildPowerShellInteractiveScript(['C:\\tools\\app.exe', 'a b'], { TRACE: '1' })
    expect(script).toContain('$env:TRACE = \'1\'')
    expect(script).toContain("& 'C:\\tools\\app.exe' 'a b'")
  })
})

describe('windows Agent Host bootstrap', () => {
  it('starts the standalone CLI through an encoded PowerShell wrapper', () => {
    const line = buildRemoteAgentHostCommand('code', 'windows')
    expect(line).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand /)
    const script = decodePowerShell(line)
    expect(script).toContain('& $dsh_code agent host --host 127.0.0.1 --port 0 --idle-timeout 60')
    expect(script).toContain('--server-data-dir "$HOME\\.dsh-remote-ssh\\server"')
    expect(script).toContain('exit $LASTEXITCODE')
    expect(script).not.toContain('command -v')
  })

  it('lists and starts embedded VS Code Servers without GNU find', () => {
    const listing = buildListEmbeddedAgentHostsCommand('windows')
    expect(decodePowerShell(listing)).toContain('Get-ChildItem -Path "$HOME\\.vscode-server\\cli\\servers"')
    const embedded = buildEmbeddedAgentHostCommand('C:\\srv\\code-server.cmd', 'attempt-1', 'windows')
    const script = decodePowerShell(embedded)
    expect(script).toContain("'C:\\srv\\code-server.cmd'")
    expect(script).toContain('--agent-host-port 0')
    expect(script).toContain('server-embedded\\attempt-1')
  })

  it('reaps orphaned embedded hosts by command line without self-matching', () => {
    const line = buildReapEmbeddedAgentHostCommand('dsh.remote-1-0', 'windows')
    const script = decodePowerShell(line)
    expect(script).toContain('Win32_Process')
    expect(script).toContain('Stop-Process')
    expect(script).toContain('server-embedded[/\\\\]dsh\\.remote-1-0')
    // The plaintext pattern only ever exists inside the encoded payload, so
    // the reap command's own process line can never match it.
    expect(line).not.toContain('dsh.remote-1-0')
    expect(() => buildReapEmbeddedAgentHostCommand('a b', 'windows')).toThrow(/invalid embedded Agent Host instance id/)
  })

  it('keeps POSIX bootstraps byte-identical to the legacy form', () => {
    expect(buildRemoteAgentHostCommand('code')).toContain('exec "$dsh_code" agent host')
    expect(buildListEmbeddedAgentHostsCommand()).toContain('sort -nr')
    expect(buildReapEmbeddedAgentHostCommand('a-1')).toContain('pkill -f')
  })
})

describe('windows workspace path mapper', () => {
  const local = resolve('tests', 'alias-win')

  it('accepts native roots and resolves every accepted spelling', () => {
    const mapper = new WorkspacePathMapper(local, 'C:\\Users\\me\\proj', 'windows')
    expect(mapper.remoteWorkspace).toBe('/C:/Users/me/proj')
    expect(mapper.toRemotePath(local)).toBe('/C:/Users/me/proj')
    expect(mapper.toRemotePath(join(local, 'src', 'main.ts'))).toBe('/C:/Users/me/proj/src/main.ts')
    expect(mapper.toRemotePath('C:\\Users\\me\\proj\\src\\app.ts')).toBe('/C:/Users/me/proj/src/app.ts')
    expect(mapper.toRemotePath('c:/users/me/proj/x')).toBe('/C:/users/me/proj/x')
    expect(mapper.toRemotePath('/C:/Users/me/proj/y')).toBe('/C:/Users/me/proj/y')
    expect(mapper.toRemotePath('src\\main.ts', local)).toBe('/C:/Users/me/proj/src/main.ts')
    expect(mapper.toRemotePath('file:///C%3A/Users/me/proj/z.ts')).toBe('/C:/Users/me/proj/z.ts')
  })

  it('still rejects escapes and non-absolute roots', () => {
    const mapper = new WorkspacePathMapper(local, 'C:\\proj', 'windows')
    expect(mapper.toRemotePath('D:\\elsewhere')).toBe('/D:/elsewhere')
    expect(() => new WorkspacePathMapper(local, 'relative', 'windows')).toThrow(/absolute Windows path/)
    expect(() => new WorkspacePathMapper(local, 'relative')).toThrow(/absolute POSIX path/)
  })
})

describe('windows shell tool execution', () => {
  it('stages a .ps1 payload and types an encoded marker wrapper', () => {
    const invocation = buildTerminalInvocation('windows', {
      token: '0f0e0d0c-1',
      command: 'Get-ChildItem',
      env: { DSH_CWD: '/C:/Users/me/proj', NO_COLOR: '1' },
      shellCommand: 'pwsh',
      commandPath: '/C:/Users/me/.dsh-remote-ssh/cli/command-1.ps1',
      stdinPath: '/C:/Users/me/.dsh-remote-ssh/cli/stdin-1.bin',
      stdinCreated: true,
    })
    expect(invocation.contentType).toBe('text/x-powershell')
    expect(invocation.payload).toContain('[Console]::OutputEncoding')
    expect(invocation.payload).toContain('Get-ChildItem')
    const script = decodePowerShell(invocation.input)
    expect(script).toContain("[char]30+'DSH:0f0e0d0c-1:BEGIN'+[char]31")
    expect(script).toContain(":END:'+$dsh_status+[char]31")
    expect(script).toContain('$env:DSH_CWD = \'C:\\Users\\me\\proj\'')
    expect(script).toContain('$env:NO_COLOR = \'1\'')
    expect(script).toContain('-ExecutionPolicy Bypass -File "C:\\Users\\me\\.dsh-remote-ssh\\cli\\command-1.ps1"')
    expect(script).toContain("OpenRead('C:\\Users\\me\\.dsh-remote-ssh\\cli\\stdin-1.bin')")
    expect(script).toContain("if ($dsh_shell -eq 'pwsh' -and -not (Get-Command pwsh")
    expect(script).toContain('exit $dsh_status')
  })

  it('keeps the POSIX invocation byte-identical', () => {
    const invocation = buildTerminalInvocation('posix', {
      token: 'abc',
      command: 'true',
      env: { K: 'v' },
      shellCommand: 'bash',
      commandPath: '/tmp/dsh/command-abc.sh',
      stdinPath: '/tmp/dsh/stdin-abc.bin',
      stdinCreated: false,
    })
    expect(invocation.contentType).toBe('text/x-shellscript')
    expect(invocation.input).toBe(`printf '\\036DSH:abc:BEGIN\\037'; env K='v' 'bash' '/tmp/dsh/command-abc.sh' < /dev/null; __dsh_status=$?; printf '\\036DSH:abc:END:%s\\037' "$__dsh_status"; exit "$__dsh_status"`)
  })
})

describe('windows remote subprocess commands', () => {
  it('builds a .NET process script with native paths', () => {
    const command = buildRemoteProcessCommand(
      ['C:\\Program Files\\tool\\app.exe', 'arg with space'],
      { SAFE: 'x y' },
      { kind: 'file', path: '/C:/rt/in.bin' },
      '/C:/rt/out.bin',
      '/C:/rt/err.bin',
      'windows',
    )
    expect(command).toContain("$psi.FileName = 'C:\\Program Files\\tool\\app.exe'")
    expect(command).toContain('"arg with space"')
    expect(command).toContain("$psi.EnvironmentVariables['SAFE'] = 'x y'")
    expect(command).toContain("OpenRead('C:\\rt\\in.bin')")
    expect(command).toContain("Create('C:\\rt\\out.bin')")
    expect(command).toContain('exit $p.ExitCode')
    expect(command).not.toContain('exec env')
  })

  it('keeps a full Windows executable and drops POSIX-remote stripping', () => {
    const windows = buildRemoteProcessCommand(['C:\\tools\\rg.exe', '-v'], undefined, { kind: 'eof' }, '/o', '/e', 'windows')
    expect(windows).toContain("'C:\\tools\\rg.exe'")
    const posix = buildRemoteProcessCommand(['C:\\tools\\rg.exe', '-v'], undefined, { kind: 'eof' }, '/o', '/e')
    expect(posix).toContain("'rg' '-v'")
  })

  it('encodes interactive argv for the default shell', () => {
    expect(buildRemoteInteractiveCommand(['rg', '--version'], undefined, 'windows')).toBe('rg --version')
    const encoded = buildRemoteInteractiveCommand(['C:\\my app\\x.exe'], { TRACE: '1' }, 'windows')
    expect(encoded).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand /)
    expect(decodePowerShell(encoded)).toContain("& 'C:\\my app\\x.exe'")
    expect(buildRemoteInteractiveCommand(['bash', '-i'], undefined)).toBe("exec env  'bash' '-i'")
  })
})

describe('windows sidebar git bridge', () => {
  it('wraps git in a byte-exact process script', () => {
    const command = buildRemoteGitCommand('C:\\my repo', ['status'], '/C:/rt/out', '/C:/rt/err', 'windows')
    expect(command).toContain("$psi.FileName = 'git'")
    expect(command).toContain('-C "C:\\my repo"')
    expect(command).toContain("Create('C:\\rt\\out')")
    expect(command).not.toContain('/dev/null')
    expect(buildRemoteGitCommand('/repo', ['status'], '/rt/out', '/rt/err')).toContain('< /dev/null')
  })
})

describe('windows server probe', () => {
  it('discriminates the remote OS through one encoded invocation', () => {
    const line = buildRemoteOsProbeCommand()
    expect(line).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/)
    expect(decodePowerShell(line)).toContain('[System.Environment]::OSVersion.Platform.ToString()')
  })

  it('probes POSIX facts first and Windows facts through PowerShell', () => {
    expect(buildPosixProbeCommand()).toContain('os=%s')
    const decoded = decodePowerShell(buildWindowsProbeCommand())
    expect(decoded).toContain('$env:COMPUTERNAME')
    expect(decoded).toContain('os=Windows_NT')
    expect(decoded).toContain("'pwsh','powershell','rg','code','bash'")
  })
})

describe('windows workspace URI and manager routing', () => {
  class MemorySettingsForms extends Service {
    private readonly sections = new Map<string, object>()
    constructor(ctx: Context) { super(ctx, 'settings') }
    get writable(): boolean { return true }
    describe(): unknown[] { return [] }
    update(ns: string, patch: object): Promise<void> {
      this.sections.set(ns, { ...(this.sections.get(ns) ?? {}), ...patch })
      return Promise.resolve()
    }
    replace(ns: string, section: object): Promise<void> {
      this.sections.set(ns, structuredClone(section))
      return Promise.resolve()
    }
    stored(ns: string): object | undefined { return this.sections.get(ns) }
  }

  async function createContext(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(MemorySettingsForms).await()
    return ctx
  }

  Object.defineProperty(Fiber.prototype, 'entry', {
    get: () => ({ options: { id: 'remote-ssh-manager' } }),
    configurable: true,
  })

  it('parses ssh:// URIs with Windows drive paths and folds backslashes', () => {
    expect(parseSshWorkspaceUri('ssh://win_laptop/C:/Users/me/proj')?.remotePath).toBe('/C:/Users/me/proj')
    expect(parseSshWorkspaceUri('ssh://win_laptop/C:\\Users\\me\\proj')?.remotePath).toBe('/C:/Users/me/proj')
    expect(parseSshWorkspaceUri('ssh://host/srv/proj')?.remotePath).toBe('/srv/proj')
  })

  it('routes native and internal Windows paths to the remote world fail-closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-win-mgr-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'winbox', label: 'Winbox', sshTarget: 'win-laptop', remoteOs: 'windows' }],
        workspaces: [{ id: 'proj', serverId: 'winbox', remotePath: 'C:\\Users\\me\\proj' }],
      })
      const manager = ctx.remoteSshManager
      const alias = resolve(root, 'proj')
      const route = manager.route('src\\main.ts', alias)
      expect(route).toMatchObject({ kind: 'remote', workspace: { remotePath: '/C:/Users/me/proj' } })
      expect(manager.route(undefined, 'C:\\Users\\me\\proj\\src\\main.ts')).toMatchObject({ kind: 'remote' })
      expect(manager.route(undefined, 'c:/users/me/PROJ/deep/file.ts')).toMatchObject({ kind: 'remote' })
      // A Windows-shaped path with no matching Windows route stays local
      // (fail-closed against accidental local execution of typed paths).
      expect(manager.route(undefined, 'D:\\unrelated')).toEqual({ kind: 'local' })
      expect(manager.dialectFor(alias)).toBe('pwsh')
      expect(manager.remoteDialect(manager.workspace('proj'))).toBe('pwsh')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps POSIX workspaces on bash and validates per-OS remote paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-posix-mgr-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'dev' }],
        workspaces: [{ id: 'proj', serverId: 'devbox', remotePath: '/srv/project' }],
      })
      const manager = ctx.remoteSshManager
      expect(manager.dialectFor(resolve(root, 'proj'))).toBe('bash')
      expect(manager.route(undefined, 'C:\\Users\\me')).toEqual({ kind: 'local' })
      const created = await manager.addWorkspace('devbox', '/srv/other')
      expect(created.workspace.remotePath).toBe('/srv/other')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists remote directories in native Windows display form', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-win-list-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'winbox', label: 'Winbox', sshTarget: 'win-laptop', remoteOs: 'windows' }],
        workspaces: [],
      })
      const manager = ctx.remoteSshManager
      const hostCtx = new Context()
      const requestedUris: string[] = []
      const remote = {
        remoteOs: 'windows' as const,
        getConnection: async () => ({
          defaultDirectory: 'file:///c%3A/Users/tester',
          client: {
            resourceList: async ({ uri }: { uri: string }) => {
              requestedUris.push(uri)
              return { entries: [{ name: 'projects', type: 'directory' }, { name: 'notes.txt', type: 'file' }] }
            },
          },
        }),
      }
      ;(manager as unknown as { createHostContext(server: unknown): Promise<unknown> }).createHostContext = async server => ({
        ctx: hostCtx, remote, key: 'win', server, transport: { executable: 'ssh', args: [], multiplexed: false },
      })
      const server = manager.snapshot().servers[0]!
      await expect(manager.listRemoteDirectory(server)).resolves.toEqual({
        path: 'C:\\Users\\tester',
        home: 'C:\\Users\\tester',
        parent: 'C:\\Users',
        entries: [{ name: 'projects', path: 'C:\\Users\\tester\\projects' }],
      })
      expect(requestedUris).toEqual(['file:///C%3A/Users/tester'])
      const driveRoot = await manager.listRemoteDirectory(server, 'C:\\')
      expect(driveRoot.path).toBe('C:\\')
      expect('parent' in driveRoot).toBe(false)
      await expect(manager.listRemoteDirectory(server, 'relative')).rejects.toThrow(/absolute Windows path/)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes and persists a native Windows workspace path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-win-add-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'winbox', label: 'Winbox', sshTarget: 'win-laptop', remoteOs: 'windows' }],
        workspaces: [],
      })
      const manager = ctx.remoteSshManager
      const created = await manager.addWorkspace('winbox', 'C:\\Users\\me\\proj')
      expect(created.workspace.remotePath).toBe('/C:/Users/me/proj')
      expect(manager.snapshot().workspaces[0]?.remotePath).toBe('/C:/Users/me/proj')
      // NTFS is case-insensitive: the same folder under any spelling is a
      // duplicate, not a second workspace.
      await expect(manager.addWorkspace('winbox', 'c:/users/me/proj/')).rejects.toThrow(/duplicate remote path/)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
