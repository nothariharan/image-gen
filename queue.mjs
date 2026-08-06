/**
 * queue.mjs — serialize image generations so only ONE job drives ChatGPT at a time.
 *
 * Cursor/agents often fire multiple generate_image calls in parallel. They all
 * attach to the same Edge CDP session and type into the same composer, which
 * interleaves keystrokes into garbage. This module provides:
 *   1) In-process mutex (same MCP server instance)
 *   2) Cross-process file lock (multiple MCP processes / overlapping clients)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LOCK_PATH =
  process.env.IMAGE_GEN_LOCK_PATH || path.join(__dirname, ".generate.lock");

const LOCK_WAIT_MS = Number(process.env.IMAGE_GEN_LOCK_WAIT_MS || 12 * 60 * 1000);
const LOCK_STALE_MS = Number(process.env.IMAGE_GEN_LOCK_STALE_MS || 6 * 60 * 1000);
const POLL_MS = 350;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockMeta() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}

function tryRemoveStaleLock() {
  const meta = readLockMeta();
  if (!meta) {
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      /* ignore */
    }
    return;
  }
  const age = Date.now() - (meta.at || 0);
  if (age > LOCK_STALE_MS || !pidAlive(meta.pid)) {
    try {
      fs.unlinkSync(LOCK_PATH);
      console.error(
        `[image-gen] Cleared stale queue lock (pid=${meta.pid}, age=${Math.round(age / 1000)}s)`,
      );
    } catch {
      /* ignore */
    }
  }
}

/** Acquire exclusive lock file. Waits until free or times out. */
export async function acquireGenerateLock() {
  const started = Date.now();
  let loggedWait = false;

  while (Date.now() - started < LOCK_WAIT_MS) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, at: Date.now() }, null, 2),
      );
      fs.closeSync(fd);
      if (loggedWait) {
        console.error(
          `[image-gen] Queue lock acquired after ${Math.round((Date.now() - started) / 1000)}s`,
        );
      }
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (!loggedWait) {
        console.error(
          "[image-gen] Another generate_image is running — queued (same ChatGPT session cannot run in parallel)",
        );
        loggedWait = true;
      }
      tryRemoveStaleLock();
      await sleep(POLL_MS);
    }
  }

  throw new Error(
    `Timed out after ${Math.round(LOCK_WAIT_MS / 1000)}s waiting for the image-gen queue. ` +
      `If nothing is generating, delete ${LOCK_PATH} and retry.`,
  );
}

export function releaseGenerateLock() {
  try {
    const meta = readLockMeta();
    // Only delete if we own it (or it's unreadable).
    if (!meta || meta.pid === process.pid) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch {
    /* ignore */
  }
}

/** In-process FIFO chain so concurrent awaits inside one process stay ordered. */
let chain = Promise.resolve();

/**
 * Run `fn` exclusively — waits for prior jobs in this process AND the file lock.
 */
export function withGenerateQueue(fn) {
  const run = chain.then(async () => {
    await acquireGenerateLock();
    try {
      return await fn();
    } finally {
      releaseGenerateLock();
    }
  });

  // Keep the chain alive even if this job fails.
  chain = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}
