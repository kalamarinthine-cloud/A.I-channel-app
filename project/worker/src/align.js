import { cleanScript } from './tts.js';

/**
 * Word timings for narration that was generated before they were recorded.
 *
 * Videos narrated by the older code path have audio and a script but no alignment between
 * them, and captions are unusable without one. ElevenLabs' forced alignment takes both and
 * returns when each word is spoken — far more accurate than transcribing the audio afresh,
 * because the exact words are already known and only their positions are in question.
 *
 * Everything narrated from now on gets timings at generation time instead (see tts.js), so
 * this exists to catch up the back catalogue rather than as part of the normal path.
 */
export async function forceAlign({ audio, script, onProgress = () => {} }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set on the worker');

  const text = cleanScript(script);
  if (!text) throw new Error('Script is empty after removing stage directions');

  onProgress(`aligning ${(audio.length / 1024 / 1024).toFixed(1)} MB of audio against ${text.length} characters`);

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'voiceover.mp3');
  form.append('text', text);

  const res = await fetch('https://api.elevenlabs.io/v1/forced-alignment', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(`Forced alignment failed: ${res.status} — ${detail}`);
  }

  const words = toWords(await res.json());
  if (words.length === 0) throw new Error('Forced alignment returned no words');

  onProgress(`aligned ${words.length} words`);
  return words;
}

/**
 * Normalises the response into `[{ w, s, e }]`.
 *
 * The endpoint returns word-level entries alongside character-level ones; words are used
 * directly when present, and folded from characters when not, so a change in which of the
 * two is returned doesn't leave captions silently empty.
 */
export function toWords(payload) {
  const fromWords = (payload?.words ?? [])
    .filter((w) => String(w.text ?? '').trim())
    .map((w) => ({ w: String(w.text).trim(), s: round(w.start), e: round(w.end) }));
  if (fromWords.length > 0) return fromWords;

  const chars = payload?.characters ?? [];
  const words = [];
  let text = '';
  let start = 0;
  let end = 0;

  const flush = () => {
    if (text.trim()) words.push({ w: text, s: round(start), e: round(end) });
    text = '';
  };

  for (const char of chars) {
    const value = String(char.text ?? '');
    if (/\s/.test(value) || value === '') {
      flush();
      continue;
    }
    if (!text) start = char.start;
    text += value;
    end = char.end ?? char.start;
  }
  flush();

  return words;
}

function round(n) {
  return +Number(n ?? 0).toFixed(3);
}
