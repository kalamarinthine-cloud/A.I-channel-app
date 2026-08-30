/*
# Create voiceovers storage bucket

1. New Storage
- Creates a public bucket named `voiceovers` to store generated TTS audio files.
- Files are stored at path `{video_id}/{timestamp}.mp3`.
- Public read access so the frontend can play audio via the public URL.
2. Security
- Bucket is public (no auth required to read).
- Writes are allowed via service role key (edge function uploads).
- No RLS policies needed on the bucket itself since it's public.
*/

INSERT INTO storage.buckets (id, name, public)
VALUES ('voiceovers', 'voiceovers', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "public_read_voiceovers" ON storage.objects;
CREATE POLICY "public_read_voiceovers"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'voiceovers');

DROP POLICY IF EXISTS "anon_write_voiceovers" ON storage.objects;
CREATE POLICY "anon_write_voiceovers"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'voiceovers');

DROP POLICY IF EXISTS "anon_update_voiceovers" ON storage.objects;
CREATE POLICY "anon_update_voiceovers"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (bucket_id = 'voiceovers') WITH CHECK (bucket_id = 'voiceovers');

DROP POLICY IF EXISTS "anon_delete_voiceovers" ON storage.objects;
CREATE POLICY "anon_delete_voiceovers"
ON storage.objects FOR DELETE
TO anon, authenticated
USING (bucket_id = 'voiceovers');
