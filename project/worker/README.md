# Render worker

Compiles finished videos with FFmpeg, outside the browser.

The app no longer renders video itself. It inserts a row into `render_jobs` and returns;
this worker claims jobs, renders them, and writes the result back to the project. Closing
the browser mid-render loses nothing, and rendering is no longer bound to real time.

## Setup

```sh
cp .env.example .env      # fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
docker build -t film-central-worker .
docker run --rm --env-file .env film-central-worker
```

The service role key is required — the worker uploads to storage and updates rows that
the anon key has no business touching from a browser. It runs where no end user can read
its environment, which is the whole reason this is a separate process. **Never put this
key in `.env` at the project root**, which Vite inlines into the client bundle.

Leave the container running. It polls every few seconds and processes one job at a time.

## Running without Docker

The worker is a plain Node script; the container only supplies FFmpeg and a font. With
FFmpeg already on your PATH:

```sh
cd worker
npm install
THUMBNAIL_FONT=C:/Windows/Fonts/arialbd.ttf npm start
```

`THUMBNAIL_FONT` is the one thing that must change. Its default is the Debian path baked
into the image, which doesn't exist on Windows or macOS — leave it unset and the worker
logs a warning at startup and skips thumbnails, rather than failing every job. Use forward
slashes; the path is escaped for FFmpeg's filter parser, which treats `:` and `\` as
syntax.

## Running more than one

Run more copies of the container. `claim_render_job` uses `FOR UPDATE SKIP LOCKED`, so
workers step over each other's rows rather than racing for the same job:

```sh
docker run -d --env-file .env -e WORKER_ID=w1 film-central-worker
docker run -d --env-file .env -e WORKER_ID=w2 film-central-worker
```

Rendering is CPU-bound, so the useful ceiling is roughly one worker per two cores.

## Hosting it

Nothing here is local-specific — the same image runs anywhere that takes a container.
On Fly.io, Railway, or Render: push the image, set the two environment variables, and run
it as a always-on worker rather than a web service (it listens on no port). On a VPS,
`docker run -d --restart unless-stopped` is enough.

Hosting it is what makes the pipeline genuinely unattended: your machine no longer has to
be on for a queued video to get made.

## What a job does

1. Claims the oldest queued job, or one abandoned by a worker that died over 15 minutes ago
2. Downloads the project's voiceover and its ready B-roll clips
3. Measures the voiceover, divides it into equal segments, one per clip
4. Renders 1920×1080 H.264/AAC MP4 — each clip scaled and cropped to fill, looped if it's
   shorter than its segment
5. Extracts a frame from the opening clip and composes the thumbnail over it
6. Uploads both, prunes the project's older files, and updates `script_projects`

A job that throws is marked `error` with the message. `claim_render_job` skips jobs past
three attempts, so a permanently broken one stops being retried instead of occupying every
worker forever.

## Known limits

- **Per-file upload cap.** Supabase rejects uploads over the project's limit — 50 MB on the
  free plan. At the current settings that is roughly two minutes of 1080p. Longer videos
  need the limit raised in Storage settings, or lower bitrate in `renderVideo`.
- **Encoder settings** live in `src/ffmpeg.js` (`-preset medium -crf 23 -maxrate 4M`).
  Raising the preset to `slow` yields smaller files for more CPU time; `veryfast` is
  roughly twice as quick but produces files about 60% larger.
