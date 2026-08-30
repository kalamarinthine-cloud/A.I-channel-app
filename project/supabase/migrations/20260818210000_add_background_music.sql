/*
# Background music

Music is generated with ElevenLabs — the same key already used for narration, so no new
service or credential — then mixed under the voiceover by the render worker with sidechain
ducking, so it dips while someone is speaking and returns in the gaps.

1. Modified Tables
- `script_projects`
  - `music_url` (text) — generated track in Storage. Generated once and reused on
    re-render, the same way a voiceover is, so re-cutting a video costs nothing extra.
  - `music_prompt` (text) — the prompt used, kept so a track can be regenerated or
    understood later
- `render_jobs`
  - `music_enabled` (boolean, default true) — per-job switch
  - `music_prompt` (text) — overrides the niche default for this job

2. New Storage
- Public bucket `music`, files at `{video_id}/{timestamp}.mp3`.

3. Security
- Public read; anon + authenticated CRUD, matching the other buckets in this
  single-tenant app.
*/

ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS music_url text DEFAULT '';
ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS music_prompt text DEFAULT '';

ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS music_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS music_prompt text DEFAULT '';

INSERT INTO storage.buckets (id, name, public)
VALUES ('music', 'music', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "public_read_music" ON storage.objects;
CREATE POLICY "public_read_music"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'music');

DROP POLICY IF EXISTS "anon_write_music" ON storage.objects;
CREATE POLICY "anon_write_music"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'music');

DROP POLICY IF EXISTS "anon_update_music" ON storage.objects;
CREATE POLICY "anon_update_music"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (bucket_id = 'music') WITH CHECK (bucket_id = 'music');

DROP POLICY IF EXISTS "anon_delete_music" ON storage.objects;
CREATE POLICY "anon_delete_music"
ON storage.objects FOR DELETE
TO anon, authenticated
USING (bucket_id = 'music');
