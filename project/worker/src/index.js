import { createClient } from '@supabase/supabase-js';
import { copyFile, mkdir, mkdtemp, readdir, rm, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkFont, probeDuration, renderVideo, renderPreview, renderThumbnail } from './ffmpeg.js';
import { hasCredentials, uploadVideo, setThumbnail } from './youtube.js';
import { pruneMasters } from './retention.js';
import { synthesise } from './tts.js';

const SUPABASE_URL = required('SUPABASE_URL');
const SERVICE_ROLE_KEY = required('SUPABASE_SERVICE_ROLE_KEY');
const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);

/** Matches the browser renderer: below this, clips flicker past too fast to read. */
const MIN_SEGMENT_SECONDS = 2;

/** Where to keep full-quality masters. Unset disables the copy entirely. */
const MASTERS_DIR = process.env.MASTERS_DIR || '';

/**
 * Retention for the masters folder. Both are off at 0, in which case nothing is ever
 * deleted — automatic deletion should be something you opted into, not a surprise.
 * When both are set, a file is removed if either rule condemns it.
 */
const MASTERS_MAX_GB = Number(process.env.MASTERS_MAX_GB || 0);
const MASTERS_KEEP_DAYS = Number(process.env.MASTERS_KEEP_DAYS || 0);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let shuttingDown = false;

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

function log(...args) {
  console.log(new Date().toISOString(), `[${WORKER_ID}]`, ...args);
}

async function setStage(jobId, stage) {
  await supabase.from('render_jobs').update({ stage }).eq('id', jobId);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/**
 * Turns a video title into a filename that is safe on Windows, macOS and Linux.
 * Windows is the strict one: it forbids \ / : * ? " < > | and rejects names ending in a
 * dot or space, so the lowest common denominator is what's applied here.
 */
function toFilename(title) {
  const cleaned = String(title || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120);
  return cleaned || 'untitled';
}

/**
 * Keeps a full-quality copy of the render on disk.
 *
 * Storage only ever gets a downscaled preview once a video runs past a couple of minutes,
 * so without this the master exists nowhere but YouTube. Copied straight after rendering,
 * before publishing or uploading, so a failure in either of those never costs the file.
 */
async function saveMaster(sourcePath, title, log) {
  if (!MASTERS_DIR) return '';

  try {
    await mkdir(MASTERS_DIR, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const base = `${date} - ${toFilename(title)}`;

    let target = path.join(MASTERS_DIR, `${base}.mp4`);
    for (let n = 2; n < 100; n++) {
      try {
        await stat(target);
        target = path.join(MASTERS_DIR, `${base} (${n}).mp4`);
      } catch {
        break; // does not exist, so the name is free
      }
    }

    await copyFile(sourcePath, target);
    log(`master saved to ${target}`);

    const { size } = await stat(target);
    await pruneMasters({
      dir: MASTERS_DIR,
      keepPath: target,
      keepSize: size,
      maxGb: MASTERS_MAX_GB,
      keepDays: MASTERS_KEEP_DAYS,
      log,
    });

    return target;
  } catch (err) {
    // Never fail a finished render over an archive copy.
    log(`could not save master locally: ${err.message}`);
    return '';
  }
}

/** Deletes everything under a project's folder except the file just written. */
async function pruneBucket(bucket, prefix, keepName) {
  try {
    const { data } = await supabase.storage.from(bucket).list(prefix);
    if (!data) return;
    const stale = data.filter((f) => f.name !== keepName).map((f) => `${prefix}/${f.name}`);
    if (stale.length > 0) await supabase.storage.from(bucket).remove(stale);
  } catch {
    // Cleanup is never worth failing a finished render over.
  }
}

async function processJob(job) {
  const workDir = await mkdtemp(path.join(tmpdir(), `render-${job.id}-`));
  log(`claimed job ${job.id} (attempt ${job.attempts})`);

  try {
    const [{ data: project }, { data: assets }] = await Promise.all([
      supabase.from('script_projects').select('*').eq('id', job.project_id).single(),
      supabase
        .from('broll_assets')
        .select('*')
        .eq('video_id', job.video_id)
        .eq('status', 'ready')
        .order('beat_index', { nullsFirst: false }),
    ]);

    if (!project) throw new Error('Project row not found');

    // --- voiceover ----------------------------------------------------------
    // Generated here rather than in an edge function: a long script needs several
    // sequential ElevenLabs calls, and edge functions are killed part way through for
    // exceeding their wall-clock budget. Skipped when the project already has audio.
    let voiceoverUrl = project.voiceover_url;

    if (!voiceoverUrl) {
      await setStage(job.id, 'voiceover');
      const voiceId = project.voiceover_voice || job.voice_id;
      if (!voiceId) throw new Error('No voice selected for this project');

      const mp3 = await synthesise({
        script: project.script_content,
        voiceId,
        onProgress: (msg) => log(`tts: ${msg}`),
      });

      const key = `${job.video_id}/${Date.now()}.mp3`;
      const { error: uploadError } = await supabase.storage
        .from('voiceovers')
        .upload(key, mp3, { contentType: 'audio/mpeg', upsert: false });
      if (uploadError) throw new Error(`Voiceover upload failed: ${uploadError.message}`);

      voiceoverUrl = supabase.storage.from('voiceovers').getPublicUrl(key).data.publicUrl;

      await supabase
        .from('script_projects')
        .update({ voiceover_url: voiceoverUrl, voiceover_voice: voiceId })
        .eq('id', job.project_id);
      await supabase
        .from('videos')
        .update({ voiceover_url: voiceoverUrl, voiceover_voice: voiceId, updated_at: new Date().toISOString() })
        .eq('id', job.video_id);

      log(`voiceover saved (${(mp3.length / 1024 / 1024).toFixed(1)} MB)`);
    }

    const clips = (assets || []).filter((a) => a.source_url && a.type !== 'music' && a.type !== 'sfx');
    if (clips.length === 0) throw new Error('No ready visual B-roll for this video');

    // --- download -----------------------------------------------------------
    await setStage(job.id, 'downloading');
    const audioPath = await download(voiceoverUrl, path.join(workDir, 'voice.mp3'));

    const clipPaths = [];
    for (const [i, asset] of clips.entries()) {
      try {
        clipPaths.push(await download(asset.source_url, path.join(workDir, `clip-${i}.mp4`)));
      } catch (err) {
        log(`skipping clip ${i}: ${err.message}`);
      }
    }
    if (clipPaths.length === 0) throw new Error('None of the B-roll clips could be downloaded');

    // --- render -------------------------------------------------------------
    const totalDuration = await probeDuration(audioPath);
    const maxSegments = Math.max(1, Math.floor(totalDuration / MIN_SEGMENT_SECONDS));
    const used = clipPaths.slice(0, Math.min(clipPaths.length, maxSegments));
    const segmentSeconds = totalDuration / used.length;

    log(`rendering ${used.length} segments x ${segmentSeconds.toFixed(1)}s = ${totalDuration.toFixed(1)}s`);
    await setStage(job.id, 'rendering');

    const startedAt = Date.now();
    const outPath = path.join(workDir, 'out.mp4');
    await renderVideo({
      audioPath,
      clipPaths: used,
      segmentSeconds,
      outPath,
      onLine: () => {},
    });
    const renderSeconds = (Date.now() - startedAt) / 1000;
    log(`rendered in ${renderSeconds.toFixed(1)}s (${(totalDuration / renderSeconds).toFixed(1)}x real time)`);

    // Archive the master first — before publishing or uploading, so neither can lose it.
    await saveMaster(outPath, project.youtube_title || `video-${job.video_id.slice(0, 8)}`, log);

    // --- thumbnail ----------------------------------------------------------
    await setStage(job.id, 'thumbnail');
    const thumbPath = path.join(workDir, 'thumb.jpg');
    let thumbnailUrl = '';
    try {
      await renderThumbnail({
        sourceClip: used[0],
        title: project.youtube_title || 'Untitled',
        workDir,
        outPath: thumbPath,
      });
    } catch (err) {
      log(`thumbnail failed, continuing: ${err.message}`);
    }

    // --- publish ------------------------------------------------------------
    // Done before the Storage upload, because this is the step that must not be blocked
    // by a size limit — YouTube is where the full-quality video actually belongs.
    let youtubeVideoId = '';
    let publishError = '';

    if (job.publish_to_youtube) {
      await setStage(job.id, 'publishing');
      try {
        if (!hasCredentials()) {
          throw new Error(
            'YouTube credentials are not set on the worker. Add YOUTUBE_CLIENT_ID, ' +
            'YOUTUBE_CLIENT_SECRET and YOUTUBE_REFRESH_TOKEN to worker/.env — the worker is a ' +
            'separate process from the edge functions and does not see their secrets.',
          );
        }

        youtubeVideoId = await uploadVideo({
          filePath: outPath,
          title: project.youtube_title || 'Untitled',
          description: project.youtube_description,
          tags: project.youtube_tags,
          privacyStatus: job.privacy_status || 'private',
          onProgress: (msg) => log(`youtube: ${msg}`),
        });
        log(`published as https://youtu.be/${youtubeVideoId}`);

        try {
          await setThumbnail({ videoId: youtubeVideoId, filePath: thumbPath });
        } catch (err) {
          log(`thumbnail not set on YouTube (needs a verified channel): ${err.message}`);
        }
      } catch (err) {
        // The render succeeded and is worth keeping even if publishing didn't.
        publishError = String(err.message).slice(0, 2000);
        log(`publish failed: ${publishError}`);
      }
    }

    // --- upload -------------------------------------------------------------
    await setStage(job.id, 'uploading');
    const stamp = Date.now();
    const masterBytes = await readFile(outPath);
    const sizeMb = masterBytes.length / (1024 * 1024);
    log(`encoded ${sizeMb.toFixed(1)} MB`);

    // Try the master first; fall back to a small preview if Storage rejects it for size.
    // The app only needs something playable — the full-quality file lives on YouTube.
    let storedPath = outPath;
    let storedBytes = masterBytes;
    let isPreview = false;

    const uploadTo = async (bytes, name) => {
      const key = `${job.video_id}/${job.project_id}/${name}`;
      const { error } = await supabase.storage
        .from('compiled_videos')
        .upload(key, bytes, { contentType: 'video/mp4', upsert: false });
      return { error, key, name };
    };

    let attempt = await uploadTo(masterBytes, `${stamp}.mp4`);

    if (attempt.error && /exceeded the maximum allowed size/i.test(attempt.error.message)) {
      log(`master too large for Storage at ${sizeMb.toFixed(1)} MB — storing a 480p preview instead`);
      await setStage(job.id, 'preview');
      storedPath = path.join(workDir, 'preview.mp4');
      await renderPreview({ sourcePath: outPath, outPath: storedPath });
      storedBytes = await readFile(storedPath);
      isPreview = true;
      log(`preview is ${(storedBytes.length / (1024 * 1024)).toFixed(1)} MB`);
      await setStage(job.id, 'uploading');
      attempt = await uploadTo(storedBytes, `${stamp}-preview.mp4`);
    }

    if (attempt.error) throw new Error(`Video upload failed: ${attempt.error.message}`);

    const videoName = attempt.name;
    const videoKey = attempt.key;

    const outputUrl = supabase.storage.from('compiled_videos').getPublicUrl(videoKey).data.publicUrl;
    await pruneBucket('compiled_videos', `${job.video_id}/${job.project_id}`, videoName);

    try {
      const thumbName = `${stamp}.jpg`;
      const thumbKey = `${job.video_id}/${job.project_id}/${thumbName}`;
      const { error: thumbError } = await supabase.storage
        .from('thumbnails')
        .upload(thumbKey, await readFile(thumbPath), { contentType: 'image/jpeg', upsert: false });
      if (!thumbError) {
        thumbnailUrl = supabase.storage.from('thumbnails').getPublicUrl(thumbKey).data.publicUrl;
        await pruneBucket('thumbnails', `${job.video_id}/${job.project_id}`, thumbName);
      }
    } catch {
      // A finished video with no thumbnail is still a finished video.
    }

    // --- record ---------------------------------------------------------------
    const projectPatch = { compiled_video_url: outputUrl, compiled_is_preview: isPreview };
    if (thumbnailUrl) projectPatch.thumbnail_url = thumbnailUrl;
    if (youtubeVideoId) {
      projectPatch.youtube_video_id = youtubeVideoId;
      projectPatch.youtube_status = 'uploaded';
    } else if (job.publish_to_youtube) {
      projectPatch.youtube_status = 'failed';
    }
    await supabase.from('script_projects').update(projectPatch).eq('id', job.project_id);

    await supabase
      .from('videos')
      .update({ status: 'editing', updated_at: new Date().toISOString() })
      .eq('id', job.video_id);

    await supabase
      .from('render_jobs')
      .update({
        status: 'done',
        stage: 'done',
        error: '',
        output_url: outputUrl,
        thumbnail_url: thumbnailUrl,
        youtube_video_id: youtubeVideoId,
        publish_error: publishError,
        finished_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    log(`job ${job.id} done`);
  } catch (err) {
    log(`job ${job.id} failed: ${err.message}`);
    await supabase
      .from('render_jobs')
      .update({
        status: 'error',
        stage: 'error',
        error: String(err.message).slice(0, 2000),
        finished_at: new Date().toISOString(),
      })
      .eq('id', job.id);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function claim() {
  const { data, error } = await supabase.rpc('claim_render_job', {
    worker: WORKER_ID,
    stale_seconds: 900,
  });
  if (error) {
    log(`claim failed: ${error.message}`);
    return null;
  }
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function main() {
  // Not fatal: a video without a thumbnail is still a usable video, so say it once here
  // instead of failing the thumbnail step on every job with the same message.
  try {
    await checkFont();
  } catch (err) {
    log(`WARNING: ${err.message}`);
    log('Videos will still render; thumbnails will be skipped.');
  }

  log(`polling ${SUPABASE_URL} every ${POLL_INTERVAL_MS}ms`);

  while (!shuttingDown) {
    const job = await claim();
    if (job) {
      await processJob(job);
    } else {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  log('shut down cleanly');
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    log(`${signal} received, finishing current job then exiting`);
    shuttingDown = true;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
