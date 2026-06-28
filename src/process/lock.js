import fs from 'fs';
import path from 'path';

const PROCESS_LOCK_FILE = path.join(process.cwd(), '.notionbot.lock');

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid() {
  try {
    const raw = fs.readFileSync(PROCESS_LOCK_FILE, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function acquireProcessLock() {
  try {
    fs.writeFileSync(PROCESS_LOCK_FILE, String(process.pid), { flag: 'wx' });
    return;
  } catch {
    const existingPid = readLockPid();
    if (existingPid && isProcessAlive(existingPid)) {
      throw new Error(`Another bot instance is already running (PID ${existingPid}).`);
    }

    try {
      fs.unlinkSync(PROCESS_LOCK_FILE);
    } catch {
      // Ignore stale lock cleanup errors and retry lock creation below.
    }

    fs.writeFileSync(PROCESS_LOCK_FILE, String(process.pid), { flag: 'wx' });
  }
}

export function releaseProcessLock() {
  try {
    if (!fs.existsSync(PROCESS_LOCK_FILE)) {
      return;
    }

    const lockPid = readLockPid();
    if (lockPid === process.pid) {
      fs.unlinkSync(PROCESS_LOCK_FILE);
    }
  } catch {
    // Best-effort cleanup.
  }
}
