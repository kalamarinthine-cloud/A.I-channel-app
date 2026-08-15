import { supabase } from '@/lib/supabase';

/**
 * Deletes every file under `prefix` except `keepPath`.
 *
 * Compiled videos and thumbnails are written to `{video_id}/{project_id}/{timestamp}.ext`,
 * and a project only ever references its most recent one. Re-compiling would otherwise
 * leave every earlier attempt sitting in the bucket with nothing pointing at it — which
 * adds up quickly, since a single minute of 1080p WebM runs to a few megabytes.
 *
 * Best-effort by design: the upload has already succeeded by the time this runs, so a
 * failure here must not fail the render. It just means some files get tidied next time.
 */
export async function pruneBucket(bucket: string, prefix: string, keepPath: string): Promise<void> {
  try {
    const { data, error } = await supabase.storage.from(bucket).list(prefix);
    if (error || !data) return;

    const stale = data
      .map((file) => `${prefix}/${file.name}`)
      .filter((path) => path !== keepPath);

    if (stale.length > 0) {
      await supabase.storage.from(bucket).remove(stale);
    }
  } catch {
    // Ignore — cleanup is never worth failing a finished render over.
  }
}
