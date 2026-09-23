import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';

type LockOwner = {
  pid: number;
  token: string;
  runtime: string;
  createdAt: string;
  processStartedAt: number;
  /** Absent in locks written before containers were considered. */
  host?: string;
  heartbeatAt?: string;
};

/** How often the owner proves it is still alive, and when silence means stale. */
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_STALE_AFTER_MS = 60_000;
const WAIT_POLL_MS = 1_000;

export type RuntimeLock = {
  path: string;
  release: () => void;
};

export class RuntimeLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeLockError';
  }
}

/**
 * Atomically owns the one process allowed to use a DB-backed runtime.
 *
 * A directory rename is used for stale-lock takeover so two reclaimers cannot
 * delete a newly acquired lock. The owner token also prevents an old process
 * from releasing a successor's lock during shutdown.
 *
 * Two liveness models, because a PID only means something inside one PID
 * namespace. On the same host the owner's PID plus its process start time is
 * the strongest evidence there is. Across containers sharing a volume it is
 * worse than useless — a redeploying container reads the old container's PID,
 * finds a process of its own wearing that number, and refuses to start against
 * a database nobody holds. A foreign owner is therefore judged by the heartbeat
 * it writes into the lock, never by its PID.
 */
export function acquireRuntimeLock(dbPath: string, runtime: string): RuntimeLock {
  const absoluteDbPath = resolve(dbPath);
  const lockPath = `${absoluteDbPath}.runtime.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });

  const startedAt = new Date().toISOString();
  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    runtime,
    createdAt: startedAt,
    processStartedAt: SELF_PROCESS_STARTED_AT,
    host: hostname(),
    heartbeatAt: startedAt,
  };
  const candidate = `${lockPath}.candidate-${owner.token}`;
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(ownerPath(candidate), JSON.stringify(owner), { mode: 0o600 });

  try {
    for (;;) {
      try {
        renameSync(candidate, lockPath);
        break;
      } catch (error) {
        if (!isAlreadyExists(error, lockPath)) throw error;
        const current = readOwner(lockPath);
        if (current) {
          const held = describeHeldLock(current, runtime, lockPath);
          if (held) throw new RuntimeLockError(held);
        }

        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          renameSync(lockPath, stalePath);
        } catch (takeoverError) {
          if (isMissing(takeoverError) || isAlreadyExists(takeoverError, stalePath)) continue;
          throw takeoverError;
        }
        rmSync(stalePath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    rmSync(candidate, { recursive: true, force: true });
    throw error;
  }

  const heartbeat = setInterval(() => {
    touchOwner(lockPath, owner);
  }, HEARTBEAT_INTERVAL_MS);
  // The heartbeat must never be the reason the process stays alive.
  heartbeat.unref();

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    process.off('exit', release);
    const current = readOwner(lockPath);
    if (current?.token !== owner.token) return;
    const releasedPath = `${lockPath}.released-${owner.token}`;
    try {
      renameSync(lockPath, releasedPath);
      rmSync(releasedPath, { recursive: true, force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };

  process.once('exit', release);
  return { path: lockPath, release };
}

/**
 * Why this lock cannot be taken, or null when it is stale and may be reclaimed.
 *
 * A same-host owner is judged by PID identity: alive with a matching process
 * start time means alive, and a mismatch means the OS reused a dead owner's
 * PID. An owner from another host or container has a PID this namespace cannot
 * read, so only its heartbeat counts; one that stopped writing for longer than
 * the stale window is gone, whatever its PID looks like here.
 */
function describeHeldLock(current: LockOwner, runtime: string, lockPath: string): string | null {
  const heartbeatAgeMs = heartbeatAge(current);
  const foreign = current.host !== undefined && current.host !== hostname();

  if (foreign) {
    if (heartbeatAgeMs === null || heartbeatAgeMs > HEARTBEAT_STALE_AFTER_MS) return null;
    return `Database runtime is already owned by ${current.runtime} on ${current.host}`
      + ` (last heartbeat ${Math.round(heartbeatAgeMs / 1000)}s ago).`
      + ` Stop that instance before starting ${runtime}; two processes must not share this database.`;
  }

  if (!isProcessAlive(current.pid)) return null;

  const observedStart = getProcessStartedAt(current.pid);
  if (observedStart === null) {
    // No process identity available (no `ps` in this image). A heartbeat that
    // stopped is still proof the owner is gone; without one, fail closed.
    if (heartbeatAgeMs !== null && heartbeatAgeMs > HEARTBEAT_STALE_AFTER_MS) return null;
    return `Database runtime lock names live pid ${current.pid}, but its process identity cannot be verified.`
      + ` Stop the owner or remove ${lockPath} only after confirming it is stale.`;
  }
  if (Math.abs(observedStart - current.processStartedAt) <= 2) {
    return `Database runtime is already owned by ${current.runtime} (pid ${current.pid}).`
      + ` Stop it before starting ${runtime}.`;
  }
  // The PID is alive but its start time does not match the lock. The OS reused
  // a crashed owner's PID, so the directory is stale.
  return null;
}

function heartbeatAge(current: LockOwner): number | null {
  if (!current.heartbeatAt) return null;
  const beatMs = Date.parse(current.heartbeatAt);
  if (!Number.isFinite(beatMs)) return null;
  return Math.max(0, Date.now() - beatMs);
}

/**
 * Refresh the owner record in place, and only while we still own it: a process
 * whose lock was reclaimed must not stamp its successor's record.
 */
function touchOwner(lockPath: string, owner: LockOwner): void {
  try {
    if (readOwner(lockPath)?.token !== owner.token) return;
    const next: LockOwner = { ...owner, heartbeatAt: new Date().toISOString() };
    const tempPath = `${lockPath}/owner.json.next`;
    writeFileSync(tempPath, JSON.stringify(next), { mode: 0o600 });
    renameSync(tempPath, ownerPath(lockPath));
  } catch {
    // A missed beat is recoverable: the next one lands, and the stale window is
    // several beats wide. A throw here would kill a healthy runtime instead.
  }
}

/**
 * Wait for a lock a deploy is about to release. A rolling deploy starts the new
 * process while the old one is still draining; without a wait the new one dies
 * on arrival, the old one keeps the database, and the deploy never converges.
 */
export async function acquireRuntimeLockWaiting(
  dbPath: string,
  runtime: string,
  waitMs: number,
): Promise<RuntimeLock> {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    try {
      return acquireRuntimeLock(dbPath, runtime);
    } catch (error) {
      if (!(error instanceof RuntimeLockError) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    }
  }
}

function ownerPath(lockPath: string): string {
  return `${lockPath}/owner.json`;
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(ownerPath(lockPath), 'utf8')) as Partial<LockOwner>;
    if (
      !Number.isSafeInteger(parsed.pid)
      || Number(parsed.pid) <= 0
      || typeof parsed.token !== 'string'
      || typeof parsed.runtime !== 'string'
      || typeof parsed.createdAt !== 'string'
      || !Number.isSafeInteger(parsed.processStartedAt)
      || Number(parsed.processStartedAt) <= 0
    ) return null;
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

// A PID is not a process identity because operating systems reuse it after a
// crash. `ps` receives only a fixed executable and a validated numeric PID;
// failure is handled fail-closed for a live foreign process.
const SELF_PROCESS_STARTED_AT = Math.floor((Date.now() - process.uptime() * 1_000) / 1_000);

function getProcessStartedAt(pid: number): number | null {
  if (pid === process.pid) return SELF_PROCESS_STARTED_AT;
  try {
    const value = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    }).trim();
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? Math.floor(millis / 1_000) : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * "The destination is already owned by someone else."
 *
 * POSIX reports that as EEXIST/ENOTEMPTY. Windows refuses a rename onto an
 * existing directory with EPERM (EACCES when the directory is held open), so
 * the destination itself, not the errno alone, decides what the failure means:
 * without this the caller would surface a raw EPERM instead of naming the
 * process that holds the lock.
 */
function isAlreadyExists(error: unknown, destination: string): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return true;
  if (code === 'EPERM' || code === 'EACCES') return existsSync(destination);
  return false;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
