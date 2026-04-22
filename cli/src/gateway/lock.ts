import { dirname } from '@std/path'
import { gatewayPidPath } from '/src/gateway/paths.ts'
import { errToString } from '/lib/errToString.ts'

/**
 * Single-instance enforcement for the gateway daemon.
 *
 * The pidfile at ~/.slv/gateway/gateway.pid is opened with O_EXCL so two
 * concurrent `slv gateway run` invocations can't both claim the slot —
 * the second one sees AlreadyExists and has to decide whether to bail
 * or take over a stale lock. Stale detection combines:
 *
 *   1. Is `pid` alive at all? (probed via `Deno.kill(pid, 'SIGCONT')`,
 *      with EPERM treated as "alive, owned by someone else" rather
 *      than "dead" — see isProcessAlive below).
 *   2. On Linux, does `/proc/<pid>/stat`'s start time match what we
 *      recorded? — PID recycling is real on long-uptime dev VPSes.
 *
 * If both checks agree the old process is gone, we atomically replace
 * the stale file and take the lock. Otherwise we refuse to start.
 */

export type LockRecord = {
  pid: number
  startedAt: string // ISO timestamp
  // Opaque string identifying the process's boot-relative start time:
  // /proc/<pid>/stat field 22 on Linux, `ps -o lstart=` output on
  // macOS. Used to detect PID recycling within a single system uptime
  // (an ISO timestamp alone can't — PID+ISO get a fresh value on
  // every lock write).
  procStartTime?: string
  port: number
}

const readProcStartTime = async (pid: number): Promise<string | null> => {
  if (Deno.build.os === 'linux') return readLinuxStartTime(pid)
  if (Deno.build.os === 'darwin') return readDarwinStartTime(pid)
  return null
}

const readLinuxStartTime = async (pid: number): Promise<string | null> => {
  try {
    const stat = await Deno.readTextFile(`/proc/${pid}/stat`)
    // /proc/<pid>/stat fields are space-separated, but field 2 (comm)
    // can contain spaces and `)`, so cut at the LAST `)`. After that
    // delimiter the layout is: state ppid pgrp ... starttime ...
    // starttime is field 22, which is index 19 in the tail array
    // (fields 3-22 = indices 0-19).
    const tailStart = stat.lastIndexOf(')')
    if (tailStart < 0) return null
    const tail = stat.slice(tailStart + 2).trim().split(/\s+/)
    return tail[19] ?? null
  } catch {
    return null
  }
}

const readDarwinStartTime = async (pid: number): Promise<string | null> => {
  // `ps -o lstart=` prints the process's absolute start time in a
  // locale-independent format (e.g. "Mon Apr 22 12:00:00 2026").
  // That's enough to distinguish a recycled PID within a single boot
  // — two processes with the same PID cannot have the exact same
  // start second.
  try {
    const out = await new Deno.Command('ps', {
      args: ['-o', 'lstart=', '-p', String(pid)],
      stdout: 'piped',
      stderr: 'null',
    }).output()
    if (!out.success) return null
    const s = new TextDecoder().decode(out.stdout).trim()
    return s.length > 0 ? s : null
  } catch {
    return null
  }
}

/**
 * True if a process with this PID exists and we can signal it.
 * Important semantic: we DO treat `PermissionDenied` (EPERM) as alive
 * rather than dead. EPERM means the PID exists but is owned by another
 * user (e.g. a root-started gateway probed by an unprivileged user);
 * treating it as dead would lead us to unlink that user's valid
 * pidfile and claim the slot, only to fail with EADDRINUSE when we
 * try to bind. Safer to refuse.
 */
const isProcessAlive = (pid: number): boolean => {
  try {
    Deno.kill(pid, 'SIGCONT')
    return true
  } catch (err) {
    if (err instanceof Deno.errors.PermissionDenied) return true
    return false
  }
}

const readExistingLock = async (): Promise<LockRecord | null> => {
  try {
    const raw = await Deno.readTextFile(gatewayPidPath)
    return JSON.parse(raw) as LockRecord
  } catch {
    return null
  }
}

const writeLock = async (rec: LockRecord): Promise<void> => {
  const path = gatewayPidPath
  await Deno.mkdir(dirname(path), { recursive: true })
  const file = await Deno.open(path, {
    createNew: true,
    write: true,
  })
  try {
    await file.write(new TextEncoder().encode(JSON.stringify(rec) + '\n'))
  } finally {
    file.close()
  }
}

export type AcquireOutcome =
  | { state: 'acquired'; record: LockRecord }
  | {
    state: 'held'
    holder: LockRecord
    reason: 'alive' | 'linux_start_time_match'
  }
  | { state: 'failed'; err: string }

/**
 * Attempt to claim the gateway lock. Stale locks (dead holder process,
 * or Linux start-time mismatch → PID recycled) are silently replaced.
 * Live holders cause `state: 'held'` — caller decides whether to
 * --force kill or bail.
 */
export const acquireGatewayLock = async (
  port: number,
): Promise<AcquireOutcome> => {
  const myStartTime = await readProcStartTime(Deno.pid)
  const record: LockRecord = {
    pid: Deno.pid,
    startedAt: new Date().toISOString(),
    procStartTime: myStartTime ?? undefined,
    port,
  }

  // Bounded-retry loop so two concurrent `slv gateway run` invocations
  // that both see a stale lock don't both return `failed` — the loser
  // re-checks and, if the winner is now alive, gets a clean `held`
  // result instead of a confusing "lost race" error.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeLock(record)
      return { state: 'acquired', record }
    } catch (err) {
      if (!(err instanceof Deno.errors.AlreadyExists)) {
        return { state: 'failed', err: errToString(err) }
      }
    }

    const existing = await readExistingLock()
    if (existing === null) {
      // File exists but couldn't be parsed. Treat as stale and
      // retry — the O_EXCL create on next iteration handles the
      // race cleanly.
      await Deno.remove(gatewayPidPath).catch(() => {})
      continue
    }

    if (!isProcessAlive(existing.pid)) {
      await Deno.remove(gatewayPidPath).catch(() => {})
      continue
    }

    // PID is alive. If we captured a boot-relative start time and it
    // matches the current /proc or `ps` readout, this is the same
    // gateway process — definitely held. If start times differ the
    // PID was recycled and the live process is unrelated; replace.
    if (existing.procStartTime) {
      const nowStart = await readProcStartTime(existing.pid)
      if (nowStart && nowStart !== existing.procStartTime) {
        await Deno.remove(gatewayPidPath).catch(() => {})
        continue
      }
      return { state: 'held', holder: existing, reason: 'linux_start_time_match' }
    }

    return { state: 'held', holder: existing, reason: 'alive' }
  }

  return {
    state: 'failed',
    err: 'acquire retry limit exceeded — concurrent gateway lock churn',
  }
}

/**
 * Release the pidfile ONLY if it still refers to us. Defends against
 * removing a foreign daemon's lock if it somehow got swapped in
 * underneath us.
 */
export const releaseGatewayLock = async (): Promise<void> => {
  const existing = await readExistingLock()
  if (!existing || existing.pid !== Deno.pid) return
  await Deno.remove(gatewayPidPath).catch(() => {})
}
