/**
 * Background music generation.
 *
 * Uses ElevenLabs' music endpoint with the same key as narration, so this adds a feature
 * without adding a service or a credential to manage.
 *
 * A short track is generated and looped to fill the video rather than commissioning
 * twenty minutes of music: looping is what background scoring does anyway, and generating
 * full length would be slow and expensive for something deliberately sitting under speech.
 */

/** Long enough not to feel like an obvious loop, short enough to be quick and cheap. */
const TRACK_MS = 90_000;

/**
 * Default mood per niche. A lookup rather than another Claude call: it costs nothing, is
 * predictable, and keeps music working when the model API is unavailable — which is not
 * hypothetical, since an overload blocked B-roll planning for a quarter of an hour.
 */
const NICHE_PROMPTS = {
  'Tech/AI': 'minimal electronic underscore, steady pulse, clean synths, no vocals, background bed',
  Finance: 'restrained corporate underscore, subtle piano and pulse, confident, no vocals',
  Motivation: 'uplifting cinematic underscore, building strings and soft percussion, no vocals',
  History: 'cinematic orchestral underscore, restrained strings, reflective, no vocals',
  'Top 10': 'light energetic underscore, steady beat, curious mood, no vocals',
  'Scary Stories': 'dark ambient drone, tense low strings, unsettling, sparse, no vocals',
  'Health & Fitness': 'warm optimistic underscore, gentle rhythm, encouraging, no vocals',
  Education: 'calm curious underscore, soft piano and light texture, unobtrusive, no vocals',
  Entertainment: 'playful modern underscore, light groove, upbeat, no vocals',
  Other: 'neutral ambient underscore, soft texture, unobtrusive, no vocals',
};

export function promptForNiche(niche) {
  return NICHE_PROMPTS[niche] ?? NICHE_PROMPTS.Other;
}

export function hasCredentials() {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

/**
 * Generates a music bed and returns MP3 bytes.
 *
 * The prompt always asks for an underscore without vocals — music with a melody line or
 * lyrics competes with narration no matter how far it is ducked.
 */
export async function generateMusic({ prompt, lengthMs = TRACK_MS, onProgress = () => {} }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set on the worker');

  onProgress(`generating ${Math.round(lengthMs / 1000)}s of music`);

  const res = await fetch('https://api.elevenlabs.io/v1/music', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({ prompt, music_length_ms: lengthMs }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs music failed: ${res.status} — ${errText.slice(0, 400)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}
