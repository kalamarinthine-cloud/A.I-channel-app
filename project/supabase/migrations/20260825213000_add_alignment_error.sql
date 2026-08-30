/*
# Alignment errors

Alignment runs on the worker, so when it fails the reason lands in a container log the app
cannot see. The Clips tab was left showing "Preparing…" indefinitely, which reads as a hang
rather than as the actionable problem it usually is — an API key without the
forced_alignment permission, say, which takes ten seconds to fix once you know.

1. Modified Tables
- `script_projects`
  - `align_error` (text) — last alignment failure, cleared when one is requested and again
    when one succeeds
*/

ALTER TABLE script_projects ADD COLUMN IF NOT EXISTS align_error text DEFAULT '';
