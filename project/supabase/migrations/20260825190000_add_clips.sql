/*
# Vertical clips

Cuts finished videos into 9:16 shorts with burned-in captions. A clip is proposed first
and rendered second: Claude reads the narration and picks moments, you adjust and choose a
caption style, and only then does the worker cut it. Proposing is cheap and reversible,
rendering is neither, so they are deliberately separate states of the same row rather than
separate tables.

1. Modified Tables
- `script_projects`
  - `master_path` (text) — where the full-quality render sits on the worker's disk. Clips
    are cut from the master, not from the Storage copy, which is a 480p preview for
    anything past a couple of minutes and far too soft to crop into.
  - `word_timings` (jsonb) — `[{ w, s, e }]`, one entry per spoken word. Captions need to
    know when each word is said. Populated at narration time from ElevenLabs' timestamps,
    or backfilled by forced alignment for videos narrated before this existed. Cached
    because both routes cost an API call and the answer never changes.

2. New Tables
- `clips`
  - `id` (uuid, primary key)
  - `video_id` / `project_id` (uuid, FK, ON DELETE CASCADE)
  - `title` (text) — the hook, used as the Short's title
  - `reason` (text) — why this moment was picked, so a low score can be argued with
  - `score` (integer) — 0-100 confidence that the moment stands alone
  - `transcript` (text) — the words inside the clip, for reviewing without playing it
  - `start_seconds` / `end_seconds` (numeric) — editable before rendering
  - `caption_style` (text) — bold | karaoke | minimal | boxed | none
  - `reframe` (text) — crop | blur, how 16:9 becomes 9:16
  - `status` (text) — proposed | queued | rendering | ready | error
  - `stage`, `attempts`, `error`, `worker_id`, `claimed_at`, `finished_at` — as render_jobs
  - `output_url`, `thumbnail_url`, `duration_seconds`
  - `publish_to_youtube` (boolean), `privacy_status` (text), `youtube_video_id`,
    `publish_error` — publishing stays opt-in per clip, as it is for full videos

3. New Storage
- Public bucket `clips`, files at `{video_id}/{clip_id}.mp4`. A minute of vertical video is
  a few MB, so unlike full renders these always fit and never need a preview.

4. Security
- Enable RLS. Allow anon + authenticated CRUD, matching the rest of this single-tenant app.

5. Function
- `claim_clip_job(worker, stale_seconds)` — the same FOR UPDATE SKIP LOCKED claim used for
  render_jobs, so one worker can serve both queues without two of them racing for a row.
*/

ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS master_path text DEFAULT '';
ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS word_timings jsonb DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS clips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES script_projects(id) ON DELETE CASCADE,
  title text DEFAULT '',
  reason text DEFAULT '',
  score integer DEFAULT 0,
  transcript text DEFAULT '',
  start_seconds numeric NOT NULL DEFAULT 0,
  end_seconds numeric NOT NULL DEFAULT 0,
  caption_style text NOT NULL DEFAULT 'bold',
  reframe text NOT NULL DEFAULT 'crop',
  status text NOT NULL DEFAULT 'proposed',
  stage text DEFAULT '',
  attempts integer NOT NULL DEFAULT 0,
  error text DEFAULT '',
  output_url text DEFAULT '',
  thumbnail_url text DEFAULT '',
  duration_seconds numeric DEFAULT 0,
  publish_to_youtube boolean NOT NULL DEFAULT false,
  privacy_status text NOT NULL DEFAULT 'private',
  youtube_video_id text DEFAULT '',
  publish_error text DEFAULT '',
  worker_id text DEFAULT '',
  claimed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  finished_at timestamptz
);

ALTER TABLE clips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_clips" ON clips;
CREATE POLICY "anon_select_clips" ON clips FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_clips" ON clips;
CREATE POLICY "anon_insert_clips" ON clips FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_clips" ON clips;
CREATE POLICY "anon_update_clips" ON clips FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_clips" ON clips;
CREATE POLICY "anon_delete_clips" ON clips FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_clips_queued ON clips(created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id, start_seconds);

/*
Claims the oldest clip that is queued, or stuck in 'rendering' because the worker holding
it died. Only ever touches rows the user has explicitly queued — a 'proposed' clip is a
suggestion and must never be rendered without being asked for.
*/
CREATE OR REPLACE FUNCTION claim_clip_job(worker text, stale_seconds integer DEFAULT 900)
RETURNS SETOF clips
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE clips
  SET status = 'rendering',
      worker_id = worker,
      claimed_at = now(),
      attempts = clips.attempts + 1,
      stage = 'claimed'
  WHERE id = (
    SELECT c.id
    FROM clips c
    WHERE (
      c.status = 'queued'
      OR (c.status = 'rendering' AND c.claimed_at < now() - make_interval(secs => stale_seconds))
    )
    AND c.attempts < 3
    ORDER BY c.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
END;
$$;

INSERT INTO storage.buckets (id, name, public)
VALUES ('clips', 'clips', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "public_read_clips" ON storage.objects;
CREATE POLICY "public_read_clips"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'clips');

DROP POLICY IF EXISTS "anon_write_clips" ON storage.objects;
CREATE POLICY "anon_write_clips"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'clips');

DROP POLICY IF EXISTS "anon_update_clips_objects" ON storage.objects;
CREATE POLICY "anon_update_clips_objects"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (bucket_id = 'clips') WITH CHECK (bucket_id = 'clips');

DROP POLICY IF EXISTS "anon_delete_clips_objects" ON storage.objects;
CREATE POLICY "anon_delete_clips_objects"
ON storage.objects FOR DELETE
TO anon, authenticated
USING (bucket_id = 'clips');
