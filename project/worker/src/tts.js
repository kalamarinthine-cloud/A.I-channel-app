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
 * Folds ElevenLabs' per-character alignment into whole words.
 *
 * The API times every character, including the spaces between words. Captions work in
 * words, so each run of non-space characters becomes one entry spanning the first
 * character's start to the last character's end.
 *
 * `offset` shifts a chunk's times into the timeline of the whole narration, since each
 * chunk is timed from zero.
 */
export function alignmentToWords(alignment, offset = 0) {
  const chars = alignment?.characters ?? [];
  const starts = alignment?.character_start_times_seconds ?? [];
  const ends = alignment?.character_end_times_seconds ?? [];
  if (!chars.length || chars.length !== starts.length) return [];

  const words = [];
  let text = '';
  let start = 0;
  let end = 0;

  const flush = () => {
    if (text.trim()) words.push({ w: text, s: +(start + offset).toFixed(3), e: +(end + offset).toFixed(3) });
    text = '';
  };

  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i])) {
      flush();
      continue;
    }
    if (!text) start = starts[i];
    text += chars[i];
    end = ends[i] ?? starts[i];
  }
  flush();

  return words;
}

/**
 * Narrates a script and returns `{ mp3, words }`.
 *
 * Chunks are sent in order rather than in parallel: ElevenLabs uses the previous request
 * to carry voice state across a boundary, so out-of-order calls make the delivery drift
 * audibly between chunks.
 *
 * The /with-timestamps variant returns the same audio plus the time every character is
 * spoken, for the same price and in the same call. Captions need those times, and asking
 * for them here means a video is never narrated without them — the alternative is aligning
 * the audio against the script afterwards, which is a second API call that can fail.
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
  const words = [];
  let previousRequestId = null;
  let offset = 0;

  for (const [i, chunk] of chunks.entries()) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        Accept: 'application/json',
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

    const payload = await res.json();
    if (!payload.audio_base64) {
      throw new Error(`ElevenLabs returned no audio on part ${i + 1} of ${chunks.length}`);
    }
    parts.push(Buffer.from(payload.audio_base64, 'base64'));

    // normalized_alignment times the text as spoken ("twenty twenty-six" for "2026"),
    // which is what the listener hears; alignment times the raw characters. Captions
    // should read like the script, so the raw alignment is preferred where present.
    const chunkWords = alignmentToWords(payload.alignment ?? payload.normalized_alignment, offset);
    words.push(...chunkWords);
    if (chunkWords.length > 0) offset = chunkWords[chunkWords.length - 1].e;

    onProgress(`narrated part ${i + 1}/${chunks.length}`);
  }

  // MP3 frames are self-contained, so concatenating encoded parts yields a valid stream.
  return { mp3: Buffer.concat(parts), words };
}
