/*
# Create script_projects table

1. New Tables
- `script_projects`
  - `id` (uuid, primary key)
  - `video_id` (uuid, FK -> videos, ON DELETE CASCADE) — which video this project belongs to
  - `script_content` (text) — the generated or written script text
  - `script_tone` (text, nullable) — tone used for generation
  - `script_instructions` (text, nullable) — extra instructions used for generation
  - `voiceover_url` (text, default '') — URL to the generated TTS audio in Storage
  - `voiceover_voice` (text, default '') — which TTS voice was used
  - `created_at` (timestamptz) — when this generation was created
2. Security
- Enable RLS on `script_projects`.
- Allow anon + authenticated CRUD (single-tenant, no sign-in).
3. Indexes
- `script_projects.video_id` for FK lookups.
- `script_projects.created_at` for ordering.
*/

CREATE TABLE IF NOT EXISTS script_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  script_content text DEFAULT '',
  script_tone text DEFAULT '',
  script_instructions text DEFAULT '',
  voiceover_url text DEFAULT '',
  voiceover_voice text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE script_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_script_projects" ON script_projects;
CREATE POLICY "anon_select_script_projects" ON script_projects FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_script_projects" ON script_projects;
CREATE POLICY "anon_insert_script_projects" ON script_projects FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_script_projects" ON script_projects;
CREATE POLICY "anon_update_script_projects" ON script_projects FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_script_projects" ON script_projects;
CREATE POLICY "anon_delete_script_projects" ON script_projects FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_script_projects_video_id ON script_projects(video_id);
CREATE INDEX IF NOT EXISTS idx_script_projects_created_at ON script_projects(created_at);
