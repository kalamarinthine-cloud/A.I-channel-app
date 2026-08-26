/*
# Alignment requests

Closes a gap between the two halves of clipping. Finding clips needs word timings, because
a clip is chosen by quoting the transcript and every quote has to resolve to a time. But
timings are only produced while narrating, so every video made before that existed could
never be clipped — and re-rendering a finished twenty-minute video purely to obtain them is
an absurd price for a caption track.

This lets the app ask for the alignment on its own: the worker aligns the existing
voiceover against the existing script and stores the result, which takes one API call and
no rendering at all.

1. Modified Tables
- `script_projects`
  - `align_requested` (boolean, default false) — set by the app, cleared by the worker when
    it claims the work

2. Function
- `claim_alignment_job(worker, stale_seconds)` — claims one project needing alignment. The
  flag is cleared as part of the claim, in the same statement, so two workers polling at
  once cannot both pick up the same project and pay for the same alignment twice.
*/

ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS align_requested boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_script_projects_align
  ON script_projects(created_at) WHERE align_requested;

CREATE OR REPLACE FUNCTION claim_alignment_job(worker text)
RETURNS SETOF script_projects
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE script_projects
  SET align_requested = false
  WHERE id = (
    SELECT p.id
    FROM script_projects p
    WHERE p.align_requested
      AND p.voiceover_url <> ''
    ORDER BY p.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
END;
$$;
