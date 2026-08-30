/*
# Publishing from the render worker

The worker already holds the finished file on disk. Uploading it to YouTube from there
removes the round trip where the video is pushed to Storage only for an edge function to
pull it back down — and with it the per-file upload limit that made anything longer than
about two minutes fail.

1. Modified Tables
- `render_jobs`
  - `publish_to_youtube` (boolean, default false) — opt-in per job. Publishing is an
    outward-facing action and each upload costs 1,600 of the 10,000 daily quota units,
    so it is never implied by simply rendering.
  - `privacy_status` (text, default 'private') — 'private' | 'unlisted' | 'public'
  - `youtube_video_id` (text) — set once the upload succeeds
  - `publish_error` (text) — a failed publish does not fail the job; the render still
    succeeded and is worth keeping
- `script_projects`
  - `compiled_is_preview` (boolean, default false) — true when the stored file is the
    downscaled preview rather than the master, so the UI can say so instead of implying
    the full-quality video is what you are watching
*/

ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS publish_to_youtube boolean NOT NULL DEFAULT false;
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS privacy_status text NOT NULL DEFAULT 'private';
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS youtube_video_id text DEFAULT '';
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS publish_error text DEFAULT '';

ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS compiled_is_preview boolean DEFAULT false;
