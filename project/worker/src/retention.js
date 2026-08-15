import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Applies retention rules to the masters folder.
 *
 * Kept in its own module so it can be imported and tested without starting the worker —
 * logic that deletes files is worth exercising somewhere other than a folder holding real
 * work.
 *
 * Rules are independent and both optional; a file goes if either condemns it:
 *   maxGb    — delete oldest first until the folder fits the budget
 *   keepDays — delete anything older than this many days
 *
 * Only `.mp4` files sitting directly in `dir` are considered. It never recurses, and never
 * removes `keepPath` (the master just written), so the newest render survives even when it
 * alone exceeds the budget.
 */
export async function pruneMasters({ dir, keepPath, keepSize, maxGb, keepDays, log = () => {} }) {
  if (!dir || (!maxGb && !keepDays)) return [];

  const files = [];
  for (const name of await readdir(dir)) {
    if (!name.toLowerCase().endsWith('.mp4')) continue;
    const full = path.join(dir, name);
    if (keepPath && path.resolve(full) === path.resolve(keepPath)) continue;
    const s = await stat(full);
    if (s.isFile()) files.push({ full, size: s.size, mtime: s.mtimeMs });
  }

  files.sort((a, b) => b.mtime - a.mtime); // newest first
  const doomed = new Map();

  if (keepDays > 0) {
    const cutoff = Date.now() - keepDays * 86_400_000;
    for (const f of files) {
      if (f.mtime < cutoff) doomed.set(f.full, `older than ${keepDays} day(s)`);
    }
  }

  if (maxGb > 0) {
    const budget = maxGb * 1024 ** 3;
    let used = keepSize || 0; // the new master counts against the budget
    for (const f of files) {
      if (doomed.has(f.full)) continue;
      if (used + f.size > budget) doomed.set(f.full, `over the ${maxGb} GB budget`);
      else used += f.size;
    }
  }

  const removed = [];
  for (const [full, reason] of doomed) {
    try {
      await unlink(full);
      removed.push(full);
      log(`pruned master (${reason}): ${path.basename(full)}`);
    } catch (err) {
      log(`could not prune ${path.basename(full)}: ${err.message}`);
    }
  }
  return removed;
}
