import { createClient } from '@supabase/supabase-js';
import { copyFile, mkdir, mkdtemp, readdir, rm, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkFont,
  probeDuration,
  renderVideo,
  renderPreview,
  renderThumbnail,
  renderClip,
  renderClipPoster,
} from './ffmpeg.js';
import { hasCredentials, uploadVideo, setThumbnail } from './youtube.js';
import { pruneMasters } from './retention.js';
import { synthesise } from './tts.js';
import { forceAlign } from './align.js';
import { buildAss, wordsInWindow } from './captions.js';
import { generateMusic, promptForNiche } from './music.js';

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

      const { mp3, words } = await synthesise({
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

      // Word timings come back with the audio and are what captions are cut against later.
      // Stored now because regenerating them afterwards costs a second API call.
      log(`voiceover timed to ${words.length} words`);
      await supabase
        .from('script_projects')
        .update({ voiceover_url: voiceoverUrl, voiceover_voice: voiceId, word_timings: words })
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

    // --- music ----------------------------------------------------------------
    // Generated once per project and reused, like the voiceover, so re-rendering a video
    // never re-bills for a track that already exists. A failure here is a warning: a video
    // without a music bed is still a finished video.
    let musicPath = null;

    if (job.music_enabled) {
      try {
        let musicUrl = project.music_url;

        if (!musicUrl) {
          await setStage(job.id, 'music');
          const { data: video } = await supabase
            .from('videos').select('niche').eq('id', job.video_id).single();
          const prompt = job.music_prompt || project.music_prompt || promptForNiche(video?.niche);

          const mp3 = await generateMusic({ prompt, onProgress: (m) => log(`music: ${m}`) });

          const key = `${job.video_id}/${Date.now()}.mp3`;
          const { error: musicUploadError } = await supabase.storage
            .from('music')
            .upload(key, mp3, { contentType: 'audio/mpeg', upsert: false });
          if (musicUploadError) throw new Error(musicUploadError.message);

          musicUrl = supabase.storage.from('music').getPublicUrl(key).data.publicUrl;
          await supabase
            .from('script_projects')
            .update({ music_url: musicUrl, music_prompt: prompt })
            .eq('id', job.project_id);
          log(`music saved (${(mp3.length / 1024).toFixed(0)} KB)`);
        }

        musicPath = await download(musicUrl, path.join(workDir, 'music.mp3'));
      } catch (err) {
        log(`music skipped: ${err.message}`);
        musicPath = null;
      }
    }

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
      musicPath,
      outPath,
      onLine: () => {},
    });
    const renderSeconds = (Date.now() - startedAt) / 1000;
    log(`rendered in ${renderSeconds.toFixed(1)}s (${(totalDuration / renderSeconds).toFixed(1)}x real time)`);

    // Archive the master first — before publishing or uploading, so neither can lose it.
    // The path is recorded because clips are cut from the master: Storage may only hold a
    // 480p preview, which is far too soft to crop into a vertical frame.
    const masterPath = await saveMaster(
      outPath,
      project.youtube_title || `video-${job.video_id.slice(0, 8)}`,
      log,
    );

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
    const tooLarge = (e) => e && /exceeded the maximum allowed size/i.test(e.message);

    if (tooLarge(attempt.error)) {
      log(`master too large for Storage at ${sizeMb.toFixed(1)} MB — encoding a preview to fit`);
      await setStage(job.id, 'preview');
      storedPath = path.join(workDir, 'preview.mp4');
      const { videoKbps, scale } = await renderPreview({
        sourcePath: outPath,
        outPath: storedPath,
        durationSeconds: totalDuration,
      });
      storedBytes = await readFile(storedPath);
      isPreview = true;
      log(`preview is ${(storedBytes.length / (1024 * 1024)).toFixed(1)} MB (${scale}, ${videoKbps}k)`);
      await setStage(job.id, 'uploading');
      attempt = await uploadTo(storedBytes, `${stamp}-preview.mp4`);
    }

    // A preview that still will not fit must not discard a master that rendered perfectly.
    // The finished video exists on disk and, if publishing was requested, on YouTube; the
    // in-app copy is a convenience, so its absence is a warning rather than a failure.
    let outputUrl = '';
    let storageNote = '';

    if (tooLarge(attempt.error)) {
      storageNote =
        `Too large for Storage even as a preview (${(storedBytes.length / (1024 * 1024)).toFixed(1)} MB). ` +
        `The full-quality video is in your masters folder` +
        (youtubeVideoId ? ' and on YouTube.' : '.');
      log(storageNote);
    } else if (attempt.error) {
      throw new Error(`Video upload failed: ${attempt.error.message}`);
    } else {
      outputUrl = supabase.storage.from('compiled_videos').getPublicUrl(attempt.key).data.publicUrl;
      await pruneBucket('compiled_videos', `${job.video_id}/${job.project_id}`, attempt.name);
    }

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
    const projectPatch = { compiled_is_preview: isPreview };
    if (masterPath) projectPatch.master_path = masterPath;
    if (outputUrl) projectPatch.compiled_video_url = outputUrl;
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
        publish_error: [publishError, storageNote].filter(Boolean).join(' | '),
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

async function setClipStage(clipId, stage) {
  await supabase.from('clips').update({ stage }).eq('id', clipId);
}

/**
 * Finds the best available copy of a finished video to cut a clip from.
 *
 * Preference order matters. The master on disk is full quality; the Storage copy is often a
 * 480p preview, and cropping a 480p frame to vertical leaves roughly 270 pixels of width —
 * unusable. The middle case covers videos rendered before master_path was recorded: the
 * file is almost certainly still there, named after the video, so it is worth looking for
 * before falling back to the preview.
 */
async function resolveClipSource({ project, workDir, log }) {
  if (project.master_path) {
    try {
      await stat(project.master_path);
      return { path: project.master_path, quality: 'master' };
    } catch {
      log(`recorded master ${project.master_path} is gone, looking for another copy`);
    }
  }

  if (MASTERS_DIR && project.youtube_title) {
    try {
      const wanted = `${toFilename(project.youtube_title)}.mp4`;
      const matches = (await readdir(MASTERS_DIR)).filter((name) => name.endsWith(wanted));
      if (matches.length > 0) {
        // Names are date-prefixed, so the last one sorted is the most recent render.
        const found = path.join(MASTERS_DIR, matches.sort().pop());
        log(`matched master by title: ${found}`);
        await recordMasterPath({ project, found, log });
        return { path: found, quality: 'master' };
      }
    } catch (err) {
      log(`could not search the masters folder: ${err.message}`);
    }
  }

  if (project.compiled_video_url) {
    log('no master on disk — falling back to the copy in Storage');
    const downloaded = await download(project.compiled_video_url, path.join(workDir, 'source.mp4'));
    return { path: downloaded, quality: project.compiled_is_preview ? 'preview' : 'master' };
  }

  throw new Error(
    'No video file to cut from. The master is not in the masters folder and there is no ' +
    'copy in Storage — re-render this video before clipping it.',
  );
}

/**
 * Writes back a master found by title, so it is only ever searched for once.
 *
 * Title matching is a recovery path, not an addressing scheme: two videos can share a
 * title, and renaming a file silently breaks it. Recording the path the first time a
 * project is clipped narrows that window to the single lookup that found it, and every
 * later clip of the same video resolves by path like one rendered after master_path
 * existed.
 *
 * Failing to save is not worth losing a clip over — the path was resolved either way, and
 * the next clip simply searches again.
 */
async function recordMasterPath({ project, found, log }) {
  const { error } = await supabase
    .from('script_projects')
    .update({ master_path: found })
    .eq('id', project.id);
  if (error) log(`could not record the master path: ${error.message}`);
  else log(`recorded master path for ${project.id}`);
}

/**
 * Word timings for a project, aligning the narration first if it has none.
 *
 * Anything narrated since timings were added already has them. Older videos are aligned
 * once here and the result cached, so the cost is paid by the first clip cut from a given
 * video and never again.
 *
 * `force` is for an alignment the user explicitly asked for, which must be able to replace
 * timings that are already stored. Without it, timings that are present but wrong are
 * permanent: the cache is checked before anything else, so every later request returns the
 * bad values and re-aligning becomes impossible. Captions drifting against the dialogue is
 * exactly what that looks like from the outside, and it is not something the user can
 * otherwise recover from.
 */
async function resolveWordTimings({ project, workDir, log, force = false }) {
  const existing = Array.isArray(project.word_timings) ? project.word_timings : [];
  if (existing.length > 0 && !force) return existing;
  if (existing.length > 0) log(`replacing ${existing.length} stored timings on request`);

  if (!project.voiceover_url) throw new Error('This video has no voiceover to align captions against');

  log(existing.length > 0 ? 'aligning the narration again' : 'no word timings stored — aligning the narration');
  const audioPath = await download(project.voiceover_url, path.join(workDir, 'align.mp3'));
  const words = await forceAlign({
    audio: await readFile(audioPath),
    script: project.script_content,
    onProgress: (msg) => log(`align: ${msg}`),
  });

  await supabase
    .from('script_projects')
    .update({ word_timings: words, align_error: '' })
    .eq('id', project.id);
  return words;
}

async function processClip(clip) {
  const workDir = await mkdtemp(path.join(tmpdir(), `clip-${clip.id}-`));
  log(`claimed clip ${clip.id} (attempt ${clip.attempts})`);

  try {
    const { data: project } = await supabase
      .from('script_projects').select('*').eq('id', clip.project_id).single();
    if (!project) throw new Error('Project row not found');

    const start = Number(clip.start_seconds);
    const end = Number(clip.end_seconds);
    const duration = end - start;
    if (!(duration > 0)) throw new Error('Clip has no duration — check its start and end times');

    // --- source ---------------------------------------------------------------
    await setClipStage(clip.id, 'sourcing');
    const source = await resolveClipSource({ project, workDir, log });
    if (source.quality === 'preview') {
      log('WARNING: cutting from a 480p preview, so this clip will be soft');
    }

    // --- captions -------------------------------------------------------------
    // A caption failure must not cost the clip: silent vertical video is still usable, and
    // the style can be changed and re-rendered afterwards.
    let assPath = '';
    if (clip.caption_style && clip.caption_style !== 'none') {
      try {
        await setClipStage(clip.id, 'captions');
        const words = await resolveWordTimings({ project, workDir, log });
        const inWindow = wordsInWindow(words, start, end);
        const ass = buildAss({ words: inWindow, styleName: clip.caption_style });
        if (ass) {
          assPath = path.join(workDir, 'captions.ass');
          await writeFile(assPath, ass, 'utf8');
          log(`captions: ${inWindow.length} words in ${clip.caption_style} style`);
        } else {
          log('captions: no words fall inside this window');
        }
      } catch (err) {
        log(`captions skipped: ${err.message}`);
        assPath = '';
      }
    }

    // --- render ---------------------------------------------------------------
    await setClipStage(clip.id, 'rendering');
    const outPath = path.join(workDir, 'clip.mp4');
    const startedAt = Date.now();
    await renderClip({
      sourcePath: source.path,
      startSeconds: start,
      durationSeconds: duration,
      reframe: clip.reframe || 'crop',
      assPath,
      outPath,
      onLine: () => {},
    });
    log(`cut ${duration.toFixed(1)}s in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

    const posterPath = path.join(workDir, 'poster.jpg');
    try {
      await renderClipPoster({ sourcePath: outPath, atSeconds: duration / 2, outPath: posterPath });
    } catch (err) {
      log(`poster failed, continuing: ${err.message}`);
    }

    // --- publish --------------------------------------------------------------
    // Before the Storage upload, for the same reason as full videos: publishing is what
    // must not be blocked by anything to do with the in-app copy.
    let youtubeVideoId = '';
    let publishError = '';

    if (clip.publish_to_youtube) {
      await setClipStage(clip.id, 'publishing');
      try {
        if (!hasCredentials()) {
          throw new Error(
            'YouTube credentials are not set on the worker. Add YOUTUBE_CLIENT_ID, ' +
            'YOUTUBE_CLIENT_SECRET and YOUTUBE_REFRESH_TOKEN to worker/.env.',
          );
        }
        youtubeVideoId = await uploadVideo({
          filePath: outPath,
          title: clip.title || project.youtube_title || 'Untitled',
          // YouTube decides what is a Short from the aspect ratio and duration, but the
          // hashtag is what reliably files it under the channel's Shorts shelf.
          description: `${clip.title || ''}\n\n#Shorts`.trim(),
          tags: project.youtube_tags,
          privacyStatus: clip.privacy_status || 'private',
          onProgress: (msg) => log(`youtube: ${msg}`),
        });
        log(`published short as https://youtu.be/${youtubeVideoId}`);
      } catch (err) {
        publishError = String(err.message).slice(0, 2000);
        log(`publish failed: ${publishError}`);
      }
    }

    // --- upload ---------------------------------------------------------------
    await setClipStage(clip.id, 'uploading');
    const bytes = await readFile(outPath);
    log(`clip is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB`);

    const key = `${clip.video_id}/${clip.id}.mp4`;
    const { error: uploadError } = await supabase.storage
      .from('clips')
      .upload(key, bytes, { contentType: 'video/mp4', upsert: true });
    if (uploadError) throw new Error(`Clip upload failed: ${uploadError.message}`);
    const outputUrl = supabase.storage.from('clips').getPublicUrl(key).data.publicUrl;

    let posterUrl = '';
    try {
      const posterKey = `${clip.video_id}/${clip.id}.jpg`;
      const { error: posterError } = await supabase.storage
        .from('clips')
        .upload(posterKey, await readFile(posterPath), { contentType: 'image/jpeg', upsert: true });
      if (!posterError) posterUrl = supabase.storage.from('clips').getPublicUrl(posterKey).data.publicUrl;
    } catch {
      // A clip without a poster frame is still a finished clip.
    }

    await supabase
      .from('clips')
      .update({
        status: 'ready',
        stage: 'done',
        error: '',
        output_url: outputUrl,
        thumbnail_url: posterUrl,
        duration_seconds: +duration.toFixed(3),
        youtube_video_id: youtubeVideoId,
        publish_error: publishError,
        finished_at: new Date().toISOString(),
      })
      .eq('id', clip.id);

    log(`clip ${clip.id} done`);
  } catch (err) {
    log(`clip ${clip.id} failed: ${err.message}`);
    await supabase
      .from('clips')
      .update({
        status: 'error',
        stage: 'error',
        error: String(err.message).slice(0, 2000),
        finished_at: new Date().toISOString(),
      })
      .eq('id', clip.id);
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

/**
 * Aligns one project's narration on request, without rendering anything.
 *
 * This is what makes the back catalogue clippable: the audio and the script both already
 * exist, so all that is missing is the mapping between them.
 */
async function processAlignment(project) {
  const workDir = await mkdtemp(path.join(tmpdir(), `align-${project.id}-`));
  log(`aligning project ${project.id}`);

  try {
    // Forced: reaching here means the alignment was asked for, and the answer already on
    // the row is the thing being replaced.
    const words = await resolveWordTimings({ project, workDir, log, force: true });
    log(`alignment stored: ${words.length} words`);
  } catch (err) {
    // Recorded on the project rather than only logged: this runs on the worker, so without
    // this the app has no way to tell a failure from work still in progress.
    log(`alignment failed for ${project.id}: ${err.message}`);
    await supabase
      .from('script_projects')
      .update({ align_error: String(err.message).slice(0, 2000) })
      .eq('id', project.id);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function claimAlignment() {
  const { data, error } = await supabase.rpc('claim_alignment_job', { worker: WORKER_ID });
  if (error) {
    log(`alignment claim failed: ${error.message}`);
    return null;
  }
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function claimClip() {
  const { data, error } = await supabase.rpc('claim_clip_job', {
    worker: WORKER_ID,
    stale_seconds: 900,
  });
  if (error) {
    log(`clip claim failed: ${error.message}`);
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

  // Full renders are checked first: a clip is cut from a finished video, so a queued render
  // is usually the thing standing between a queued clip and being able to run at all.
  while (!shuttingDown) {
    const job = await claim();
    if (job) {
      await processJob(job);
      continue;
    }

    const clip = await claimClip();
    if (clip) {
      await processClip(clip);
      continue;
    }

    // Cheapest of the three and a prerequisite for finding clips at all, so it is never
    // left waiting behind a queue of renders.
    const alignment = await claimAlignment();
    if (alignment) {
      await processAlignment(alignment);
      continue;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
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
