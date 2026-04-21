import { join } from '@std/path'
import { configRoot } from '@cmn/constants/path.ts'
import type { BotConfig } from '@cmn/zod/bot.ts'

// Non-Linux localhost backend: the binary is started in the background via
// `nohup`, its PID is written to <configRoot>/bot/runtime/<name>.pid, and
// stdout/stderr are appended to <configRoot>/bot/runtime/<name>.log.
// Used on macOS because there is no systemd; Linux still uses systemd.

const runtimeDir = (): string => join(configRoot, 'bot', 'runtime')
export const pidPath = (name: string): string =>
  join(runtimeDir(), `${name}.pid`)
export const logPath = (name: string): string =>
  join(runtimeDir(), `${name}.log`)

export const isLocalNonSystemd = (
  config: Pick<BotConfig, 'ip'>,
): boolean => config.ip === 'localhost' && Deno.build.os !== 'linux'

export const readPid = async (name: string): Promise<number | null> => {
  try {
    const raw = (await Deno.readTextFile(pidPath(name))).trim()
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

// Probe whether a PID is alive. SIGCONT is harmless on running processes
// (kernel resumes stopped ones, no-op on running ones). If the process has
// exited, Deno.kill throws NotFound.
export const isAlive = (pid: number): boolean => {
  try {
    Deno.kill(pid, 'SIGCONT')
    return true
  } catch {
    return false
  }
}

const errToString = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

export type StartResult =
  | { ok: true; pid: number }
  | { ok: false; err: string }

export const startLocalProc = async (
  config: BotConfig,
): Promise<StartResult> => {
  await Deno.mkdir(runtimeDir(), { recursive: true })

  const existing = await readPid(config.name)
  if (existing && isAlive(existing)) {
    return { ok: false, err: `already running (pid=${existing})` }
  }
  if (existing) {
    // Stale pidfile from a prior crash — clean up before relaunch.
    await Deno.remove(pidPath(config.name)).catch(() => {})
  }

  const binary =
    `${config.localProjectPath}/target/release/${config.binaryName}`
  try {
    const st = await Deno.stat(binary)
    if (!st.isFile) throw new Error('not a file')
  } catch {
    return { ok: false, err: `binary not found: ${binary}` }
  }

  // `sh -c '…' _ "$1" "$2"` passes paths as positional parameters so they
  // aren't re-parsed by the shell (no injection via paths containing $ or `).
  // $! is the PID of the just-backgrounded process, which nohup exec's into
  // so it stays the PID of the bot binary itself.
  const script = 'nohup "$1" >> "$2" 2>&1 & echo $!'
  const cmd = new Deno.Command('sh', {
    args: ['-c', script, '_', binary, logPath(config.name)],
    cwd: config.localProjectPath,
    stdout: 'piped',
    stderr: 'piped',
  })
  const out = await cmd.output()
  if (!out.success) {
    return {
      ok: false,
      err: new TextDecoder().decode(out.stderr).trim() ||
        'spawn failed',
    }
  }
  const pid = Number(new TextDecoder().decode(out.stdout).trim())
  if (!Number.isFinite(pid) || pid <= 0) {
    return { ok: false, err: 'failed to capture pid' }
  }

  try {
    await Deno.writeTextFile(pidPath(config.name), String(pid))
  } catch (e) {
    // Pid wasn't recorded — try to stop what we just started so the caller
    // doesn't leak an unmanaged process.
    try {
      Deno.kill(pid, 'SIGTERM')
    } catch { /* best-effort */ }
    return { ok: false, err: `failed to write pidfile: ${errToString(e)}` }
  }

  return { ok: true, pid }
}

export type StopResult =
  | { ok: true; pid: number }
  | { ok: false; err: string }

export const stopLocalProc = async (
  config: BotConfig,
): Promise<StopResult> => {
  const pid = await readPid(config.name)
  if (pid === null) return { ok: false, err: 'not running (no pidfile)' }
  if (!isAlive(pid)) {
    await Deno.remove(pidPath(config.name)).catch(() => {})
    return { ok: false, err: `stale pidfile (pid=${pid} not alive) — removed` }
  }

  try {
    Deno.kill(pid, 'SIGTERM')
  } catch (e) {
    return { ok: false, err: errToString(e) }
  }

  // Give the bot up to ~5 s to exit cleanly, then escalate to SIGKILL.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (!isAlive(pid)) break
  }
  if (isAlive(pid)) {
    try {
      Deno.kill(pid, 'SIGKILL')
    } catch { /* already gone */ }
  }
  await Deno.remove(pidPath(config.name)).catch(() => {})
  return { ok: true, pid }
}

export const statusLocalProc = async (config: BotConfig): Promise<string> => {
  const pid = await readPid(config.name)
  if (pid === null) {
    return `● ${config.name}: stopped (no pidfile)\n  log: ${
      logPath(config.name)
    }`
  }
  const alive = isAlive(pid)
  const label = alive ? 'active (running)' : 'inactive (stale pidfile)'
  return `● ${config.name}: ${label}\n  pid: ${pid}\n  log: ${
    logPath(config.name)
  }`
}

export const tailLocalLog = async (
  config: BotConfig,
  lines: number,
): Promise<string> => {
  const log = logPath(config.name)
  try {
    const out = await new Deno.Command('tail', {
      args: ['-n', String(lines), log],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    if (!out.success) {
      return new TextDecoder().decode(out.stderr)
    }
    return new TextDecoder().decode(out.stdout)
  } catch (e) {
    return `failed to read log (${log}): ${errToString(e)}`
  }
}
