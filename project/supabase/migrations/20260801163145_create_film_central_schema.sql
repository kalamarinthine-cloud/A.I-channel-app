/*
# Film Central.ai — Core Schema (single-tenant, no auth)

1. New Tables
- `videos`
  - `id` (uuid, primary key)
  - `title` (text, not null) — working title of the video
  - `niche` (text, not null) — e.g. "Tech/AI", "Finance", "Motivation"
  - `runtime` (text, not null) — target length, e.g. "Short (<2 min)", "Medium (2-8 min)", "Long (8-20 min)"
  - `status` (text, not null) — pipeline stage: idea, script_ready, recording, editing, published
  - `script_content` (text) — full pasted script text
  - `notes` (text) — freeform notes
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)
- `broll_assets`
  - `id` (uuid, primary key)
  - `video_id` (uuid, FK → videos, ON DELETE CASCADE)
  - `label` (text, not null) — what the clip/asset is
  - `source_url` (text) — link to the asset (Pexels, stock library, etc.)
  - `type` (text, not null) — "footage", "image", "screen_recording", "music", "sfx"
  - `status` (text, not null) — "needed", "sourced", "ready"
  - `created_at` (timestamptz)
2. Security
- Enable RLS on both tables.
- Allow anon + authenticated CRUD (single-tenant, no sign-in).
3. Indexes
- `broll_assets.video_id` foreign key lookup index.
- `videos.status` and `videos.niche` for filtering.
*/

CREATE TABLE IF NOT EXISTS videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  niche text NOT NULL DEFAULT 'Tech/AI',
  runtime text NOT NULL DEFAULT 'Medium (2-8 min)',
  status text NOT NULL DEFAULT 'idea',
  script_content text DEFAULT '',
  notes text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_videos" ON videos;
CREATE POLICY "anon_select_videos" ON videos FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_videos" ON videos;
CREATE POLICY "anon_insert_videos" ON videos FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_videos" ON videos;
CREATE POLICY "anon_update_videos" ON videos FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_videos" ON videos;
CREATE POLICY "anon_delete_videos" ON videos FOR DELETE
  TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS broll_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  label text NOT NULL,
  source_url text DEFAULT '',
  type text NOT NULL DEFAULT 'footage',
  status text NOT NULL DEFAULT 'needed',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE broll_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_broll" ON broll_assets;
CREATE POLICY "anon_select_broll" ON broll_assets FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_broll" ON broll_assets;
CREATE POLICY "anon_insert_broll" ON broll_assets FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_broll" ON broll_assets;
CREATE POLICY "anon_update_broll" ON broll_assets FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_broll" ON broll_assets;
CREATE POLICY "anon_delete_broll" ON broll_assets FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_broll_video_id ON broll_assets(video_id);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_niche ON videos(niche);
