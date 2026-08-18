const MAX_CHARS_PER_REQUEST = 4500;

/**
 * Narration synthesis, moved here from the edge function.
 *
 * A long script needs several sequential ElevenLabs calls, and edge functions are killed
 * for exceeding their wall-clock budget (HTTP 546) part way through — a 3,000-word script
 * reliably blew past it. The worker has no such limit, so this is simply the right home
 * for work that takes minutes.
 */

/** Removes section headers and stage directions so only spoken narration is read aloud. */
export function cleanScript(text) {
  return String(text || '')
    .replace(
      /\[(?:INTRO|SECTION\s*\d*[^]*?|OUTRO|B-?ROLL[^]*?|VISUAL[^]*?|CUE[^]*?|SCENE[^]*?|FADE[^]*?|CUT[^]*?|SHOW[^]*?|NOTE[^]*?|MUSIC[^]*?|SFX[^]*?)[\]]/gi,
      '',
    )
    .replace(/^\s*\[[^\]]+\]\s*$/gim, '')
    .replace(/^\s*#+\s.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Splits text into chunks under `limit`, preferring sentence endings and only breaking
 * mid-sentence when a single sentence exceeds the limit on its own. Splitting at a fixed
 * offset would clip words in half at every join.
 */
export function splitForTts(text, limit = MAX_CHARS_PER_REQUEST) {
  if (text.length <= limit) return [text];

  const units = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)\s*/g) ?? [text];
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current.trim().length > 0) chunks.push(current.trim());
    current = '';
  };

  for (const unit of units) {
    if (unit.length > limit) {
      flush();
      let buffer = '';
      for (const word of unit.split(/(\s+)/)) {
        if (buffer.length + word.length > limit) {
          if (buffer.trim()) chunks.push(buffer.trim());
          buffer = '';
        }
        buffer += word;
      }
      if (buffer.trim()) chunks.push(buffer.trim());
      continue;
    }
    if (current.length + unit.length > limit) flush();
    current += unit;
  }

  flush();
  return chunks.filter((c) => c.length > 0);
}

export function hasCredentials() {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

/**
 * Narrates a script and returns MP3 bytes.
 *
 * Chunks are sent in order rather than in parallel: ElevenLabs uses the previous request
 * to carry voice state across a boundary, so out-of-order calls make the delivery drift
 * audibly between chunks.
 */
export async function synthesise({ script, voiceId, onProgress = () => {} }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ELEVENLABS_API_KEY is not set on the worker. Add it to worker/.env — the worker is a ' +
      'separate process from the edge functions and does not see their secrets.',
    );
  }

  const cleaned = cleanScript(script);
  if (!cleaned) throw new Error('Script is empty after removing stage directions');

  const chunks = splitForTts(cleaned);
  onProgress(`narrating ${cleaned.length} characters in ${chunks.length} part(s)`);

  const parts = [];
  let previousRequestId = null;

  for (const [i, chunk] of chunks.entries()) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: chunk,
        model_id: 'eleven_multilingual_v2',
        ...(previousRequestId ? { previous_request_ids: [previousRequestId] } : {}),
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `ElevenLabs failed on part ${i + 1} of ${chunks.length}: ${res.status} — ${errText.slice(0, 400)}`,
      );
    }

    previousRequestId = res.headers.get('request-id');
    parts.push(Buffer.from(await res.arrayBuffer()));
    onProgress(`narrated part ${i + 1}/${chunks.length}`);
  }

  // MP3 frames are self-contained, so concatenating encoded parts yields a valid stream.
  return Buffer.concat(parts);
}
