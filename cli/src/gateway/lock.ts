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
  linuxStartTime?: string // /proc/<pid>/stat field 22 (clock ticks since boot)
  port: number
}

const readLinuxStartTime = async (pid: number): Promise<string | null> => {
  if (Deno.build.os !== 'linux') return null
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
    const raw = await Deno.readTextFile(gatewayPidPath())
    return JSON.parse(raw) as LockRecord
  } catch {
    return null
  }
}

const writeLock = async (rec: LockRecord): Promise<void> => {
  const path = gatewayPidPath()
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
  const myStartTime = await readLinuxStartTime(Deno.pid)
  const record: LockRecord = {
    pid: Deno.pid,
    startedAt: new Date().toISOString(),
    linuxStartTime: myStartTime ?? undefined,
    port,
  }

  try {
    await writeLock(record)
    return { state: 'acquired', record }
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) {
      return { state: 'failed', err: errToString(err) }
    }
  }

  // Lock file exists — inspect it to decide stale vs live.
  const existing = await readExistingLock()
  if (existing === null) {
    // File exists but couldn't be parsed. Treat as stale and overwrite.
    return await replaceStaleAndClaim(record)
  }

  if (!isProcessAlive(existing.pid)) {
    return await replaceStaleAndClaim(record)
  }

  // PID is alive. If we have a Linux start time and it matches, it IS
  // the same gateway process — definitely held. If start times don't
  // match, the PID was recycled and the live process is unrelated.
  if (existing.linuxStartTime) {
    const nowStart = await readLinuxStartTime(existing.pid)
    if (nowStart && nowStart !== existing.linuxStartTime) {
      return await replaceStaleAndClaim(record)
    }
    return { state: 'held', holder: existing, reason: 'linux_start_time_match' }
  }

  return { state: 'held', holder: existing, reason: 'alive' }
}

const replaceStaleAndClaim = async (
  record: LockRecord,
): Promise<AcquireOutcome> => {
  await Deno.remove(gatewayPidPath()).catch(() => {})
  try {
    await writeLock(record)
    return { state: 'acquired', record }
  } catch (err) {
    // If a concurrent `slv gateway run` won the race for the stale
    // slot, we land here. The real holder will succeed; we bail with
    // a clear error so the caller can surface it.
    return {
      state: 'failed',
      err: `lost race to claim stale lock: ${errToString(err)}`,
    }
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
  await Deno.remove(gatewayPidPath()).catch(() => {})
}
