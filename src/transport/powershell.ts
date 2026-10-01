/**
 * PowerShell script generation for Windows SSH remotes.
 *
 * Every remote invocation goes through `powershell -NoProfile
 * -NonInteractive -EncodedCommand <base64 UTF-16LE>`: the typed or exec'd
 * line then contains only `[A-Za-z0-9=+/]`, which survives the Windows
 * OpenSSH DefaultShell (cmd.exe or powershell.exe) quoting rules without
 * any escaping, and side-steps cmd metacharacters and PowerShell backtick
 * rules entirely.
 */

/** Console encodings the generated wrappers and staged payloads rely on. */
export const POWERSHELL_UTF8_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** Quote one value as a PowerShell single-quoted string literal. */
export function quotePowerShell(value: string): string {
  if (value.includes('\0')) throw new Error('PowerShell string values cannot contain NUL bytes')
  return `'${value.replaceAll("'", "''")}'`
}

/** Escape text for embedding inside a single-quoted PS literal (no quotes added). */
function psLiteral(value: string): string {
  return value.replaceAll("'", "''")
}

/** Base64(UTF-16LE) payload for `powershell -EncodedCommand`. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Default-shell-proof one-shot invocation wrapping {@link script}. */
export function powerShellCommand(script: string): string {
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`
}

/**
 * One-shot remote OS discriminator: succeeds with `Win32NT` only on Windows
 * (in-box PowerShell always exists there); POSIX hosts without a `powershell`
 * binary exit 127, and a PowerShell-on-POSIX install reports `Unix`.
 */
export function buildRemoteOsProbeCommand(): string {
  return powerShellCommand('Write-Output ([System.Environment]::OSVersion.Platform.ToString())')
}

/** `[Console]::Write` emitter that never appends a newline (marker-safe). */
export function psWrite(text: string): string {
  return `[Console]::Write('${psLiteral(text)}')`
}

/** Emit one RS/US-framed shell-tool marker: `\x1eDSH:<token>:BEGIN\x1f`. */
export function psMarkerBegin(token: string): string {
  return `[Console]::Write([char]30+'DSH:${psLiteral(token)}:BEGIN'+[char]31)`
}

/** Emit `\x1eDSH:<token>:END:<status>\x1f` for the given status expression. */
export function psMarkerEnd(token: string, statusExpression: string): string {
  return `[Console]::Write([char]30+'DSH:${psLiteral(token)}:END:'+${statusExpression}+[char]31)`
}

/** CreateProcess/MSVCRT argument quoting, as required by `ProcessStartInfo.Arguments`. */
export function quoteWindowsArgument(argument: string): string {
  if (argument.includes('\0')) throw new Error('Windows process arguments cannot contain NUL bytes')
  if (argument === '') return '""'
  if (!/[\s"]/.test(argument)) return argument
  let escaped = ''
  let backslashes = 0
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      escaped += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    escaped += '\\'.repeat(backslashes) + character
    backslashes = 0
  }
  escaped += '\\'.repeat(backslashes * 2)
  return `"${escaped}"`
}

/** Join argv with CreateProcess quoting for `ProcessStartInfo.Arguments`. */
export function quoteWindowsArguments(argv: readonly string[]): string {
  return argv.map(quoteWindowsArgument).join(' ')
}

export type PowerShellStdin =
  | { kind: 'eof' }
  | { kind: 'file'; path: string }
  | { kind: 'pipe'; name: string }

export interface PowerShellProcessOptions {
  /** Executable file name, optionally an absolute native Windows path. */
  fileName: string
  /** Arguments already quoted with {@link quoteWindowsArgument} by the caller, or raw argv here. */
  args?: readonly string[]
  /** Environment overlays; `undefined` values remove a variable. */
  env?: Readonly<Record<string, string | undefined>>
  /** Stdin wiring; defaults to an immediately-closed redirected stream. */
  stdin?: PowerShellStdin
  /** Collect stdout into this native file; omit to inherit the PTY. */
  stdoutPath?: string
  /** Collect stderr into this native file; omit to inherit the PTY. */
  stderrPath?: string
}

/**
 * Build a self-contained PowerShell script that starts one process with
 * .NET `ProcessStartInfo`: byte-exact file redirections (Windows PowerShell
 * 5.1's `>` would re-encode to UTF-16), a closed or file-backed stdin, and
 * the child's exit code as the script's exit code.
 */
export function buildPowerShellProcessScript(options: PowerShellProcessOptions): string {
  const lines: string[] = [
    '$ErrorActionPreference = \'Stop\'',
    '$psi = New-Object System.Diagnostics.ProcessStartInfo',
    `$psi.FileName = ${quotePowerShell(options.fileName)}`,
    `$psi.Arguments = ${quotePowerShell(quoteWindowsArguments(options.args ?? []))}`,
    '$psi.UseShellExecute = $false',
    '$psi.RedirectStandardInput = $true',
  ]
  const collects = options.stdoutPath !== undefined || options.stderrPath !== undefined
  if (options.stdoutPath !== undefined) lines.push('$psi.RedirectStandardOutput = $true')
  if (options.stderrPath !== undefined) lines.push('$psi.RedirectStandardError = $true')
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) lines.push(`$psi.EnvironmentVariables.Remove(${quotePowerShell(key)})`)
    else lines.push(`$psi.EnvironmentVariables[${quotePowerShell(key)}] = ${quotePowerShell(value)}`)
  }
  lines.push(
    '$p = [System.Diagnostics.Process]::Start($psi)',
    ...(collects ? [
      ...(options.stdoutPath !== undefined ? [`$outFile = [System.IO.File]::Create(${quotePowerShell(options.stdoutPath)})`] : []),
      ...(options.stderrPath !== undefined ? [`$errFile = [System.IO.File]::Create(${quotePowerShell(options.stderrPath)})`] : []),
      ...(options.stdoutPath !== undefined ? ['$stdoutTask = $p.StandardOutput.BaseStream.CopyToAsync($outFile)'] : []),
      ...(options.stderrPath !== undefined ? ['$stderrTask = $p.StandardError.BaseStream.CopyToAsync($errFile)'] : []),
    ] : []),
  )
  const stdin = options.stdin ?? { kind: 'eof' as const }
  if (stdin.kind === 'file') {
    lines.push(
      `$stdinFile = [System.IO.File]::OpenRead(${quotePowerShell(stdin.path)})`,
      // A child that never reads stdin and exits early legitimately breaks
      // the pipe mid-copy; that is not a wrapper failure.
      'try { $stdinFile.CopyTo($p.StandardInput.BaseStream) } catch { }',
      '$stdinFile.Close()',
    )
  } else if (stdin.kind === 'pipe') {
    lines.push(
      `$pipeClient = New-Object System.IO.Pipes.NamedPipeClientStream('.', ${quotePowerShell(stdin.name)}, [System.IO.Pipes.PipeDirection]::In)`,
      '$pipeClient.Connect(60000)',
      'try { $pipeClient.CopyTo($p.StandardInput.BaseStream) } catch { }',
      '$pipeClient.Close()',
    )
  }
  lines.push('try { $p.StandardInput.Close() } catch { }')
  if (collects) {
    lines.push(
      ...(options.stdoutPath !== undefined ? ['[void]$stdoutTask.Wait()'] : []),
      ...(options.stderrPath !== undefined ? ['[void]$stderrTask.Wait()'] : []),
      ...(options.stdoutPath !== undefined ? ['$outFile.Close()'] : []),
      ...(options.stderrPath !== undefined ? ['$errFile.Close()'] : []),
    )
  }
  lines.push('$p.WaitForExit()', 'exit $p.ExitCode')
  return lines.join('\n')
}

/**
 * Build the interactive invocation typed into a remote PTY: environment
 * overlays plus `& exe args`, inheriting the terminal's stdio. The caller
 * wraps the result with {@link powerShellCommand} so the default shell
 * never parses the payload.
 */
export function buildPowerShellInteractiveScript(
  argv: readonly string[],
  env?: Readonly<Record<string, string>>,
): string {
  if (argv.length === 0 || argv[0] === undefined || argv[0].length === 0) {
    throw new Error('dsh-remote-ssh: interactive argv must contain a program')
  }
  const lines: string[] = []
  for (const [key, value] of Object.entries(env ?? {})) {
    lines.push(`$env:${key} = ${quotePowerShell(value)}`)
  }
  lines.push(`& ${argv.map(quotePowerShell).join(' ')}`, 'exit $LASTEXITCODE')
  return lines.join('\n')
}

/**
 * Build the stdin-writer script for live remote stdin on Windows: host a
 * named pipe, read newline-delimited base64 records from the PTY, decode
 * them into the pipe, and stop at the unguessable end-marker line — the
 * same wire protocol the POSIX `while IFS= read -r … | base64 -d` loop uses.
 */
export function buildPowerShellStdinWriterScript(pipeName: string, endMarker: string): string {
  return [
    '$ErrorActionPreference = \'Stop\'',
    `$pipe = New-Object System.IO.Pipes.NamedPipeServerStream(${quotePowerShell(pipeName)}, [System.IO.Pipes.PipeDirection]::Out)`,
    '$pipe.WaitForConnection()',
    `$writer = New-Object System.IO.BinaryWriter($pipe)`,
    'while ($true) {',
    '  $line = [Console]::In.ReadLine()',
    '  if ($null -eq $line) { break }',
    `  if ($line -eq ${quotePowerShell(endMarker)}) { break }`,
    '  $bytes = [Convert]::FromBase64String($line)',
    // The consumer may exit without draining stdin; a broken pipe then ends
    // the stream instead of failing the pump.
    '  try { $writer.Write($bytes) } catch { break }',
    '}',
    '$writer.Flush()',
    '$pipe.Close()',
    'exit 0',
  ].join('\n')
}
