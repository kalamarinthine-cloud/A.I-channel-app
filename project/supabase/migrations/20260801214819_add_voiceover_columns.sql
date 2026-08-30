/*
# Add voiceover_url column to videos

1. Modified Tables
- `videos`
  - Added `voiceover_url` (text, nullable) — stores a reference to the generated TTS audio file.
  - Added `voiceover_voice` (text, nullable) — stores which TTS voice was used (e.g. "alloy", "echo").
2. Security
- No new tables. Existing RLS policies on `videos` already cover the new columns (UPDATE policy uses USING (true) WITH CHECK (true)).
*/

ALTER TABLE videos ADD COLUMN IF NOT EXISTS voiceover_url text DEFAULT '';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS voiceover_voice text DEFAULT '';
