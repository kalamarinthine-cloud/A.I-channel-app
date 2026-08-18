/*
# Carry the chosen voice on the render job

Voiceover generation moved from an edge function into the render worker. A long script
needs several sequential ElevenLabs calls, and edge functions are terminated part way
through for exceeding their wall-clock budget (HTTP 546) — a 3,000-word script failed
every time, which made the "Long (8-20 min)" preset unusable.

The worker now narrates the script itself when the project has no audio yet, so it needs
to know which voice to use.

1. Modified Tables
- `render_jobs`
  - `voice_id` (text) — ElevenLabs voice for this job. Only consulted when the project
    has no voiceover; an existing one is never re-narrated.
*/

ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS voice_id text DEFAULT '';
