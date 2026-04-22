import { dirname } from '@std/path'
import { gatewayPidPath } from '/src/gateway/paths.ts'
import { errToString } from '/lib/errToString.ts'

/**
 * Single-instance enforcement for the gateway daemon.
 *
 * The pidfile at ~/.slv/gateway/gateway.pid is opened with O_EXCL so two
 * concurrent `slv gateway run` invocations can't both claim the slot —
 * the second one sees AlreadyExists and has to decide whether to bail or
 * take over a stale lock. Stale detection combines:
 *
 *   1. Is `pid` alive at all? (`Deno.kill(pid, 'SIGCONT')` probe)
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
    // can contain spaces — strip it out by cutting between the last ')'
    // and the rest. Field 22 (starttime) is then index 19 in the tail.
    const tailStart = stat.lastIndexOf(')')
    if (tailStart < 0) return null
    const tail = stat.slice(tailStart + 2).split(/\s+/)
    return tail[19] ?? null
  } catch {
    return null
  }
}

const isProcessAlive = (pid: number): boolean => {
  try {
    Deno.kill(pid, 'SIGCONT')
    return true
  } catch {
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
    await Deno.remove(gatewayPidPath()).catch(() => {})
    try {
      await writeLock(record)
      return { state: 'acquired', record }
    } catch (err2) {
      return { state: 'failed', err: errToString(err2) }
    }
  }

  if (!isProcessAlive(existing.pid)) {
    await Deno.remove(gatewayPidPath()).catch(() => {})
    try {
      await writeLock(record)
      return { state: 'acquired', record }
    } catch (err2) {
      return { state: 'failed', err: errToString(err2) }
    }
  }

  // PID is alive. If we have a Linux start time and it matches, it IS
  // the same gateway process — definitely held. If start times don't
  // match, the PID was recycled and the live process is unrelated.
  if (existing.linuxStartTime) {
    const nowStart = await readLinuxStartTime(existing.pid)
    if (nowStart && nowStart !== existing.linuxStartTime) {
      await Deno.remove(gatewayPidPath()).catch(() => {})
      try {
        await writeLock(record)
        return { state: 'acquired', record }
      } catch (err2) {
        return { state: 'failed', err: errToString(err2) }
      }
    }
    return { state: 'held', holder: existing, reason: 'linux_start_time_match' }
  }

  return { state: 'held', holder: existing, reason: 'alive' }
}

/** Best-effort cleanup on graceful shutdown. */
export const releaseGatewayLock = async (): Promise<void> => {
  await Deno.remove(gatewayPidPath()).catch(() => {})
}
