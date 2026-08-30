/*
# Add compiled_video_url to script_projects + create compiled_videos storage bucket

1. Modified Tables
- `script_projects`
  - Added `compiled_video_url` (text, default '') — public URL of the auto-edited video stored in Supabase Storage.
2. New Storage
- Creates a public bucket named `compiled_videos` to store auto-edited video files (WebM format).
- Files are stored at path `{video_id}/{project_id}/{timestamp}.webm`.
- Public read access so the frontend can play and download videos.
3. Security
- Bucket is public (no auth required to read).
- CRUD policies for anon + authenticated (single-tenant, no sign-in).
*/

ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS compiled_video_url text DEFAULT '';

INSERT INTO storage.buckets (id, name, public)
VALUES ('compiled_videos', 'compiled_videos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "public_read_compiled_videos" ON storage.objects;
CREATE POLICY "public_read_compiled_videos"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'compiled_videos');

DROP POLICY IF EXISTS "anon_write_compiled_videos" ON storage.objects;
CREATE POLICY "anon_write_compiled_videos"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'compiled_videos');

DROP POLICY IF EXISTS "anon_update_compiled_videos" ON storage.objects;
CREATE POLICY "anon_update_compiled_videos"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (bucket_id = 'compiled_videos') WITH CHECK (bucket_id = 'compiled_videos');

DROP POLICY IF EXISTS "anon_delete_compiled_videos" ON storage.objects;
CREATE POLICY "anon_delete_compiled_videos"
ON storage.objects FOR DELETE
TO anon, authenticated
USING (bucket_id = 'compiled_videos');
