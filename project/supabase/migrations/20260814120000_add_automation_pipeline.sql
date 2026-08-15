/*
# Automation pipeline — metadata, thumbnails, and run tracking

1. Modified Tables
- `script_projects`
  - `youtube_title` (text) — AI-generated, YouTube-ready title (may differ from the working title)
  - `youtube_description` (text) — AI-generated description with hook, summary, and CTA
  - `youtube_tags` (text[]) — AI-generated tag list
  - `thumbnail_url` (text) — public URL of the generated thumbnail in Storage
  - `youtube_video_id` (text) — set once the video has been pushed to YouTube
  - `youtube_status` (text) — '', 'uploading', 'uploaded', 'failed'
  - `pipeline_status` (text) — last known automated-run state: '', 'running', 'done', 'error'
  - `pipeline_step` (text) — which step the run reached (script, metadata, voiceover, broll, compile, thumbnail)
  - `pipeline_error` (text) — failure message from the last automated run
  - `auto_generated` (boolean) — true when the project came from the one-button Produce flow
- `broll_assets`
  - `beat_index` (integer) — ordering hint from the AI b-roll plan; NULL for manually added assets
  - `search_query` (text) — the query that sourced this clip, kept for re-sourcing
2. New Storage
- Public bucket `thumbnails`, files at `{video_id}/{project_id}/{timestamp}.png`.
3. Security
- Bucket is public read; anon + authenticated CRUD (single-tenant, no sign-in), matching the
  existing `voiceovers` and `compiled_videos` buckets.
4. Indexes
- `broll_assets.beat_index` so the compiler can order clips by their position in the script.
*/

ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS youtube_title text DEFAULT '';
ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS youtube_description text DEFAULT '';
ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS youtube_tags text[] DEFAULT '{}';
ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS thumbnail_url text DEFAULT '';
ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS youtube_video_id text DEFAULT '';
ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS youtube_status text DEFAULT '';
ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS pipeline_status text DEFAULT '';
ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS pipeline_step text DEFAULT '';
ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS pipeline_error text DEFAULT '';
ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS auto_generated boolean DEFAULT false;

ALTER TABLE broll_assets ADD COLUMN IF NOT EXISTS beat_index integer;
ALTER TABLE broll_assets ADD COLUMN IF NOT EXISTS search_query text DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_broll_beat_index ON broll_assets(video_id, beat_index);

INSERT INTO storage.buckets (id, name, public)
VALUES ('thumbnails', 'thumbnails', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "public_read_thumbnails" ON storage.objects;
CREATE POLICY "public_read_thumbnails"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'thumbnails');

DROP POLICY IF EXISTS "anon_write_thumbnails" ON storage.objects;
CREATE POLICY "anon_write_thumbnails"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'thumbnails');

DROP POLICY IF EXISTS "anon_update_thumbnails" ON storage.objects;
CREATE POLICY "anon_update_thumbnails"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (bucket_id = 'thumbnails') WITH CHECK (bucket_id = 'thumbnails');

DROP POLICY IF EXISTS "anon_delete_thumbnails" ON storage.objects;
CREATE POLICY "anon_delete_thumbnails"
ON storage.objects FOR DELETE
TO anon, authenticated
USING (bucket_id = 'thumbnails');
