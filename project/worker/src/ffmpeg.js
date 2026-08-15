import { spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/**
 * Path to the font used for thumbnail titles. Defaults to where the Docker image puts
 * DejaVu; override with THUMBNAIL_FONT when running the worker outside the container,
 * since that path is Debian-specific and won't exist on Windows or macOS.
 */
const FONT = process.env.THUMBNAIL_FONT || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

/** Runs a command and rejects with its stderr tail, which is where FFmpeg puts the reason. */
export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().split('\n').slice(-8).join('\n')}`));
    });
  });
}

export async function probeDuration(file) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const seconds = Number.parseFloat(out);
  if (!Number.isFinite(seconds)) throw new Error(`Could not read duration from ${file}`);
  return seconds;
}

/**
 * Renders the finished video.
 *
 * Each clip becomes one segment of equal length. `-stream_loop -1` paired with `-t` makes
 * a clip shorter than its segment repeat to fill it, which is what the browser renderer
 * needed the loop attribute for — here FFmpeg handles it natively and far faster.
 *
 * Output is H.264/AAC in MP4 rather than the browser path's WebM: it is what YouTube
 * prefers, and it plays anywhere without transcoding.
 */
export async function renderVideo({ audioPath, clipPaths, segmentSeconds, outPath, onLine }) {
  const args = ['-y', '-i', audioPath];

  for (const clip of clipPaths) {
    args.push('-stream_loop', '-1', '-t', segmentSeconds.toFixed(3), '-i', clip);
  }

  const filters = clipPaths
    .map((_, i) =>
      `[${i + 1}:v]scale=1920:1080:force_original_aspect_ratio=increase,` +
      `crop=1920:1080,setsar=1,fps=30[v${i}]`)
    .join(';');

  const concatInputs = clipPaths.map((_, i) => `[v${i}]`).join('');
  const filterGraph = `${filters};${concatInputs}concat=n=${clipPaths.length}:v=1:a=0[outv]`;

  args.push(
    '-filter_complex', filterGraph,
    '-map', '[outv]',
    '-map', '0:a',
    '-c:v', 'libx264',
    // `medium` compresses far better than `veryfast` for a modest time cost, and we are
    // no longer racing real time. crf 23 with a hard bitrate ceiling keeps the output
    // predictable in size, which matters because Supabase rejects oversized uploads.
    '-preset', 'medium',
    '-crf', '23',
    '-maxrate', '4M',
    '-bufsize', '8M',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    '-shortest',
    outPath,
  );

  await runWithProgress('ffmpeg', args, onLine);
  return outPath;
}

/**
 * Transcodes a finished render down to a small 480p preview.
 *
 * Used when the master is too large for Storage's per-file limit. The app still needs
 * something playable in Assembly and Projects, and at these settings even a twenty-minute
 * video lands comfortably under 50 MB. Re-encoding the finished file is much faster than
 * rendering again from the source clips.
 */
export async function renderPreview({ sourcePath, outPath }) {
  await run('ffmpeg', [
    '-y',
    '-i', sourcePath,
    '-vf', 'scale=854:480',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '30',
    '-maxrate', '500k',
    '-bufsize', '1M',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    outPath,
  ]);
  return outPath;
}

/**
 * Builds the thumbnail: a frame from the opening clip, darkened toward the bottom, with
 * the title over it. Text is passed via textfile so titles containing colons, quotes or
 * commas can't break the filter syntax — drawtext's escaping rules are a menace.
 */
export async function renderThumbnail({ sourceClip, title, workDir, outPath }) {
  // Uppercase DejaVu Sans Bold averages ~0.68em per glyph — noticeably wider than the
  // mixed-case average, which is what makes a naive estimate run off the right edge.
  const ADVANCE = 0.68;
  const MARGIN = 52;
  const usableWidth = 1280 - MARGIN * 2;

  const lines = wrapTitle(title.toUpperCase(), 20, 3);
  const fontSize = Math.min(80, Math.floor(usableWidth / (longest(lines) * ADVANCE)));
  const lineHeight = Math.round(fontSize * 1.12);
  const blockHeight = lineHeight * lines.length;

  const drawtexts = [];
  for (let i = 0; i < lines.length; i++) {
    const file = path.join(workDir, `title-${i}.txt`);
    await writeFile(file, lines[i], 'utf8');
    const y = 720 - 56 - blockHeight + lineHeight * i;
    drawtexts.push(
      `drawtext=fontfile=${escapePath(FONT)}:textfile=${escapePath(file)}:` +
      `fontcolor=white:fontsize=${fontSize}:borderw=${Math.max(3, Math.round(fontSize * 0.08))}:` +
      `bordercolor=black@0.9:x=${MARGIN}:y=${y}`,
    );
  }

  const filter = [
    'scale=1280:720:force_original_aspect_ratio=increase',
    'crop=1280:720',
    // Scrim so the title stays legible over busy footage.
    'drawbox=x=0:y=300:w=1280:h=420:color=black@0.55:t=fill',
    ...drawtexts,
    // Accent bar, matching the app's brand cyan.
    'drawbox=x=0:y=708:w=1280:h=12:color=0x2dd4ff:t=fill',
  ].join(',');

  await run('ffmpeg', [
    '-y',
    '-ss', '1',
    '-i', sourceClip,
    '-frames:v', '1',
    '-vf', filter,
    outPath,
  ]);

  return outPath;
}

function runWithProgress(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr.on('data', (d) => {
      const text = String(d);
      stderr += text;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
      if (onLine) {
        for (const line of text.split(/[\r\n]+/)) {
          if (line.startsWith('frame=') || line.includes('time=')) onLine(line.trim());
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().split('\n').slice(-8).join('\n')}`));
    });
  });
}

function wrapTitle(text, maxChars, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

function longest(lines) {
  return lines.reduce((max, line) => Math.max(max, line.length), 1);
}

/**
 * FFmpeg filter arguments treat ':' and '\' specially even inside option values, so a
 * Windows path like C:\Windows\Fonts\arialbd.ttf has to become C\:/Windows/Fonts/... to
 * survive the parser.
 */
function escapePath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

/** Throws early if the configured font is missing, rather than failing on every job. */
export async function checkFont() {
  try {
    await access(FONT, constants.R_OK);
  } catch {
    throw new Error(
      `Thumbnail font not found at ${FONT}. Set THUMBNAIL_FONT to a .ttf on this machine ` +
      `(e.g. C:/Windows/Fonts/arialbd.ttf), or run the worker via Docker where the default exists.`,
    );
  }
}
