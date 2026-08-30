/*
# Render queue

Moves video compiling off the browser. The app enqueues a job and returns; a worker
process claims it, renders with FFmpeg, and writes the result back. This is what
removes the "keep this tab open" constraint and the real-time rendering floor.

1. New Tables
- `render_jobs`
  - `id` (uuid, primary key)
  - `video_id` (uuid, FK -> videos, ON DELETE CASCADE)
  - `project_id` (uuid, FK -> script_projects, ON DELETE CASCADE)
  - `status` (text) — 'queued' | 'rendering' | 'done' | 'error'
  - `stage` (text) — coarse progress for the UI: downloading, rendering, thumbnail, uploading
  - `attempts` (integer) — incremented on each claim, so a job that keeps crashing a
    worker can be abandoned rather than poisoning the queue forever
  - `error` (text)
  - `output_url` (text) — public URL of the finished video
  - `thumbnail_url` (text)
  - `worker_id` (text) — which worker holds the claim, for debugging
  - `claimed_at` (timestamptz) — used to reclaim jobs from workers that died mid-render
  - `created_at` / `finished_at` (timestamptz)
2. Security
- Enable RLS. Allow anon + authenticated CRUD, matching the rest of this single-tenant app.
3. Indexes
- Partial index on queued jobs, since that is the only query the worker's poll loop runs.
- `project_id` for the UI looking up a project's latest job.
4. Function
- `claim_render_job(worker text, stale_seconds int)` atomically claims the oldest eligible
  job. Doing this in SQL with FOR UPDATE SKIP LOCKED is what makes it safe to run more
  than one worker — two workers polling plain SELECT-then-UPDATE would race and both
  render the same job.
*/

CREATE TABLE IF NOT EXISTS render_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES script_projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  stage text DEFAULT '',
  attempts integer NOT NULL DEFAULT 0,
  error text DEFAULT '',
  output_url text DEFAULT '',
  thumbnail_url text DEFAULT '',
  worker_id text DEFAULT '',
  claimed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  finished_at timestamptz
);

ALTER TABLE render_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_render_jobs" ON render_jobs;
CREATE POLICY "anon_select_render_jobs" ON render_jobs FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_render_jobs" ON render_jobs;
CREATE POLICY "anon_insert_render_jobs" ON render_jobs FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_render_jobs" ON render_jobs;
CREATE POLICY "anon_update_render_jobs" ON render_jobs FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_render_jobs" ON render_jobs;
CREATE POLICY "anon_delete_render_jobs" ON render_jobs FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_render_jobs_queued
  ON render_jobs(created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_render_jobs_project ON render_jobs(project_id, created_at DESC);

/*
Claims the oldest job that is either queued, or stuck in 'rendering' because the worker
holding it died. SKIP LOCKED lets concurrent workers step over each other's rows instead
of blocking, so scaling out is just running more copies of the container.
*/
CREATE OR REPLACE FUNCTION claim_render_job(worker text, stale_seconds integer DEFAULT 900)
RETURNS SETOF render_jobs
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE render_jobs
  SET status = 'rendering',
      worker_id = worker,
      claimed_at = now(),
      attempts = render_jobs.attempts + 1,
      stage = 'claimed'
  WHERE id = (
    SELECT j.id
    FROM render_jobs j
    WHERE (
      j.status = 'queued'
      OR (j.status = 'rendering' AND j.claimed_at < now() - make_interval(secs => stale_seconds))
    )
    AND j.attempts < 3
    ORDER BY j.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
END;
$$;
