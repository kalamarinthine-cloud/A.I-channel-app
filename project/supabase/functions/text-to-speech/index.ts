import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

/**
 * ElevenLabs caps a single request, and a long script runs well past it. Scripts used to
 * be truncated here, which silently narrated only the opening of anything longer than
 * roughly 850 words — a 3,000-word script became a third of a video that stopped
 * mid-sentence.
 */
const MAX_CHARS_PER_REQUEST = 4500;

/**
 * Splits text into chunks under `limit`, preferring paragraph breaks, then sentence
 * endings, and only splitting mid-sentence when a single sentence is itself too long.
 * Cutting at a fixed offset would clip words in half at every join.
 */
export function splitForTts(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  // Sentence-ish units that keep their trailing punctuation and whitespace.
  const units = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)\s*/g) ?? [text];

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim().length > 0) chunks.push(current.trim());
    current = "";
  };

  for (const unit of units) {
    if (unit.length > limit) {
      // A single sentence longer than the limit: fall back to word boundaries.
      flush();
      let buffer = "";
      for (const word of unit.split(/(\s+)/)) {
        if (buffer.length + word.length > limit) {
          if (buffer.trim()) chunks.push(buffer.trim());
          buffer = "";
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { text, voiceId, videoId } = await req.json();

    if (!text || text.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Text is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("ELEVENLABS_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "ElevenLabs API key not configured. Add it in Settings > Secrets." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Strip bracketed section headers and stage directions so TTS reads only spoken narration
    const cleanedText = text
      .replace(/\[(?:INTRO|SECTION\s*\d*[^]*?|OUTRO|B-?ROLL[^]*?|VISUAL[^]*?|CUE[^]*?|SCENE[^]*?|FADE[^]*?|CUT[^]*?|SHOW[^]*?|NOTE[^]*?|MUSIC[^]*?|SFX[^]*?)[\]]/gi, '')
      .replace(/^\s*\[[^\]]+\]\s*$/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const chunks = splitForTts(cleanedText, MAX_CHARS_PER_REQUEST);

    // Chunks are narrated in order and the audio concatenated. Doing them sequentially
    // rather than in parallel matters: ElevenLabs carries voice state between requests
    // via request stitching, and out-of-order calls make the delivery drift audibly
    // between chunks.
    const parts: Uint8Array[] = [];
    let previousRequestId: string | null = null;

    for (const [i, chunk] of chunks.entries()) {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: chunk,
          model_id: "eleven_multilingual_v2",
          // Stitching tells ElevenLabs what came immediately before, so prosody carries
          // across a boundary instead of resetting mid-paragraph.
          ...(previousRequestId ? { previous_request_ids: [previousRequestId] } : {}),
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return new Response(
          JSON.stringify({
            error: `ElevenLabs request failed on part ${i + 1} of ${chunks.length}: ${response.status} — ${errText}`,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      previousRequestId = response.headers.get("request-id");
      parts.push(new Uint8Array(await response.arrayBuffer()));
    }

    // MP3 frames are self-contained, so appending encoded parts yields a valid stream.
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    const audioBuffer = merged.buffer;

    // Upload to Supabase Storage
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const filePath = `${videoId ?? "unassigned"}/${Date.now()}.mp3`;

    const { error: uploadError } = await supabase.storage
      .from("voiceovers")
      .upload(filePath, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: false,
      });

    if (uploadError) {
      return new Response(JSON.stringify({ error: `Failed to upload voiceover: ${uploadError.message}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: publicUrlData } = supabase.storage
      .from("voiceovers")
      .getPublicUrl(filePath);

    return new Response(JSON.stringify({ url: publicUrlData.publicUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
