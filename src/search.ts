import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { quotePosix } from './index.ts'

export interface Config {
  ripgrepCommand?: string
  maxGlobResults?: number
  maxGrepMatches?: number
  rawOutputMaxBytes?: number
  timeoutMs?: number
}

interface ResolvedConfig extends Config {
  ripgrepCommand: string
  maxGlobResults: number
  maxGrepMatches: number
  rawOutputMaxBytes: number
  timeoutMs: number
}

interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

export const name = 'remote-ssh-search'
export const inject = ['tools', 'systemPrompt', 'shell', 'remoteSsh']
export const Config: z<Config> = z.object({
  ripgrepCommand: z.string().default('rg'),
  maxGlobResults: z.number().default(100),
  maxGrepMatches: z.number().default(250),
  rawOutputMaxBytes: z.number().default(16 * 1024 * 1024),
  timeoutMs: z.number().default(60_000),
})

export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  for (const field of ['maxGlobResults', 'maxGrepMatches', 'rawOutputMaxBytes', 'timeoutMs'] as const) {
    if (!Number.isSafeInteger(resolved[field]) || resolved[field] <= 0) {
      throw new Error(`dsh-remote-ssh/search: ${field} must be a positive integer`)
    }
  }
  if (resolved.ripgrepCommand.trim().length === 0) throw new Error('dsh-remote-ssh/search: ripgrepCommand must be non-empty')

  ctx.systemPrompt.section({
    name: 'tool:remote-ssh-search',
    order: 103,
    text: 'Use glob and grep for workspace discovery. Both tools run ripgrep on the Remote SSH host through VS Code Agent Host; returned paths refer to the remote workspace.',
  })

  ctx.tools.register(defineTool({
    name: 'glob',
    description: `Find remote workspace files matching a glob. Returns at most ${resolved.maxGlobResults} paths; hidden and ignored files are included while VCS metadata is excluded.`,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Ripgrep glob pattern, for example "**/*.ts" or "package.json".' },
      path: { type: 'string', description: 'Remote directory to search. Defaults to the session workspace.' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGlob(value.root, value.paths, value.truncated) }],
    },
    async execute(args, exec) {
      if (args.pattern.trim().length === 0) throw new Error('pattern must be non-empty')
      if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be non-empty when provided')
      const cwd = exec.agent?.session.header.cwd ?? (ctx.remoteSsh.mapper ?? ctx.remoteSsh.getMapper()).localWorkspace
      const searchPath = mapSearchPath(ctx, args.path, cwd)
      const argv = [
        resolved.ripgrepCommand,
        '--files',
        '--color=never',
        `--glob=${args.pattern}`,
        '--sort=modified',
        '--no-ignore',
        '--hidden',
        '--glob=!**/.git', '--glob=!**/.git/**',
        '--glob=!**/.hg', '--glob=!**/.hg/**',
        '--glob=!**/.svn', '--glob=!**/.svn/**',
        '--',
        searchPath,
      ]
      const run = await runRemoteRg(ctx, argv, cwd, exec.signal, resolved)
      if (run.exitCode === 1) return { root: args.path ?? '.', paths: [], truncated: false }
      assertSearchSuccess('glob', run)
      const all = lines(run.stdout.text).map(path => displayPath(ctx, path))
      return {
        root: args.path ?? '.',
        paths: all.slice(0, resolved.maxGlobResults),
        truncated: all.length > resolved.maxGlobResults || run.stdout.truncated,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grep',
    description: `Search remote workspace file contents with ripgrep. Returns at most ${resolved.maxGrepMatches} matching lines.`,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression in ripgrep syntax.' },
      path: { type: 'string', description: 'Remote file or directory to search. Defaults to the session workspace.' },
      include: { type: 'string', description: 'Optional single glob filter, such as "*.ts".' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGrep(value.matches, value.truncated) }],
    },
    async execute(args, exec) {
      if (args.pattern.length === 0) throw new Error('pattern must be non-empty')
      if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be non-empty when provided')
      if (args.include !== undefined && (args.include.length === 0 || args.include.startsWith('!'))) {
        throw new Error('include must be a non-empty, non-negated glob')
      }
      const cwd = exec.agent?.session.header.cwd ?? (ctx.remoteSsh.mapper ?? ctx.remoteSsh.getMapper()).localWorkspace
      const searchPath = mapSearchPath(ctx, args.path, cwd)
      const argv = [resolved.ripgrepCommand, '--json', '--color=never', `--regexp=${args.pattern}`]
      if (args.include !== undefined) argv.push(`--glob=${args.include}`)
      argv.push('--', searchPath)
      const run = await runRemoteRg(ctx, argv, cwd, exec.signal, resolved)
      if (run.exitCode === 1) return { matches: [], truncated: false }
      assertSearchSuccess('grep', run)
      const matches = parseGrep(run.stdout.text, ctx)
      return {
        matches: matches.slice(0, resolved.maxGrepMatches),
        truncated: matches.length > resolved.maxGrepMatches || run.stdout.truncated,
      }
    },
  }))
}

async function runRemoteRg(
  ctx: Context,
  argv: string[],
  workdir: string,
  signal: AbortSignal,
  config: ResolvedConfig,
) {
  const command = argv.map(quotePosix).join(' ')
  return ctx.shell.run(ctx.shell.resolve({
    command,
    workdir,
    signal,
    timeoutMs: config.timeoutMs,
    stdoutMaxBytes: config.rawOutputMaxBytes,
  }))
}

function mapSearchPath(ctx: Context, input: string | undefined, cwd: string): string {
  if (input === undefined) return '.'
  if (input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input)) return (ctx.remoteSsh.mapper ?? ctx.remoteSsh.getMapper()).toRemotePath(input, cwd)
  return input.replaceAll('\\', '/')
}

function displayPath(ctx: Context, path: string): string {
  if (path.startsWith('/')) return (ctx.remoteSsh.mapper ?? ctx.remoteSsh.getMapper()).toDisplayPath(path)
  return path.replaceAll('\\', '/')
}

function assertSearchSuccess(tool: string, run: Awaited<ReturnType<typeof runRemoteRg>>): void {
  if (run.timedOut) throw new Error(`${tool} timed out`)
  if (run.aborted) throw new Error(`${tool} was aborted`)
  if (run.stdout.truncated) throw new Error(`${tool} raw output exceeded the configured byte limit`)
  if (run.exitCode !== 0) {
    throw new Error(`remote ripgrep failed for ${tool} (exit ${run.exitCode ?? 'signal'}): ${run.stdout.text.slice(-4096)}`)
  }
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).filter(Boolean)
}

function parseGrep(value: string, ctx: Context): GrepMatch[] {
  const result: GrepMatch[] = []
  for (const line of lines(value)) {
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch (error: unknown) {
      throw new Error('remote ripgrep emitted malformed JSON', { cause: error })
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const record = parsed as { type?: unknown; data?: unknown }
    if (record.type !== 'match' || typeof record.data !== 'object' || record.data === null) continue
    const data = record.data as { path?: unknown; line_number?: unknown; lines?: unknown }
    const rawPath = textField(data.path)
    if (rawPath === undefined || typeof data.line_number !== 'number' || typeof data.lines !== 'object' || data.lines === null) {
      throw new Error('remote ripgrep emitted an incomplete match record')
    }
    const lineData = data.lines as { text?: unknown; bytes?: unknown }
    result.push({
      path: displayPath(ctx, rawPath),
      lineNumber: data.line_number,
      line: typeof lineData.text === 'string' ? lineData.text.replace(/\r?\n$/, '') : '(line is not valid UTF-8)',
    })
  }
  return result
}

function textField(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const text = (value as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

function renderGlob(root: string, paths: string[], truncated: boolean): string {
  if (paths.length === 0) return `No files matched under ${root}.`
  const suffix = truncated ? '\n\n(Result capped; narrow the pattern or path.)' : ''
  return `Root: ${root}\n\n${paths.join('\n')}${suffix}`
}

function renderGrep(matches: GrepMatch[], truncated: boolean): string {
  if (matches.length === 0) return 'No matches found.'
  const groups = new Map<string, GrepMatch[]>()
  for (const match of matches) groups.set(match.path, [...(groups.get(match.path) ?? []), match])
  const body = [...groups].map(([path, fileMatches]) =>
    `${path}:\n${fileMatches.map(match => `  ${match.lineNumber}: ${match.line}`).join('\n')}`,
  ).join('\n\n')
  return truncated ? `${body}\n\n(Result capped; narrow the pattern or path.)` : body
}

export default apply
