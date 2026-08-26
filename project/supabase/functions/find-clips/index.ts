import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { callAnthropic } from "../_shared/anthropic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface Word {
  w: string;
  s: number;
  e: number;
}

/**
 * Claude returns the words a clip starts and ends on rather than timestamps.
 *
 * Asking a model for numbers means trusting it to do arithmetic against a transcript it is
 * reading as prose, and it drifts — by seconds at first and by whole paragraphs in a long
 * script. Quoting is the thing language models are reliable at, and the quote maps back to
 * an exact time because every word already carries one.
 */
const CLIPS_SCHEMA = {
  type: "object",
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "Hook for the Short, under 60 characters. This is the on-screen title and the YouTube title, so it must make someone stop scrolling without misrepresenting the clip.",
          },
          quote_start: {
            type: "string",
            description:
              "The first 4-8 words of the clip, copied verbatim from the transcript. Must match the transcript exactly.",
          },
          quote_end: {
            type: "string",
            description:
              "The last 4-8 words of the clip, copied verbatim from the transcript. Must match the transcript exactly and appear after quote_start.",
          },
          reason: {
            type: "string",
            description: "One sentence on why this moment works as a standalone short.",
          },
          score: {
            type: "integer",
            description:
              "0-100 confidence that this stands alone without the rest of the video. Be honest — a low score is more useful than a flattering one.",
          },
        },
        required: ["title", "quote_start", "quote_end", "reason", "score"],
        additionalProperties: false,
      },
    },
  },
  required: ["clips"],
  additionalProperties: false,
};

/** Punctuation and case vary between the script and the spoken words; neither should block a match. */
function normalise(text: string): string[] {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Finds where a quoted phrase sits in the word list, returning the index of its first word.
 *
 * Falls back to progressively shorter prefixes of the quote: a model that paraphrases the
 * tail of a phrase but gets its opening right should still place the clip roughly correctly
 * rather than have it dropped entirely.
 */
function findPhrase(words: string[], phrase: string, from = 0): number {
  const needle = normalise(phrase);
  if (needle.length === 0) return -1;

  for (let length = needle.length; length >= 2; length--) {
    const slice = needle.slice(0, length);
    for (let i = from; i <= words.length - slice.length; i++) {
      let hit = true;
      for (let j = 0; j < slice.length; j++) {
        if (words[i + j] !== slice[j]) {
          hit = false;
          break;
        }
      }
      if (hit) return i;
    }
  }
  return -1;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { title, niche, words, count = 5, minSeconds = 20, maxSeconds = 60 } = await req.json();

    const timings: Word[] = Array.isArray(words) ? words : [];
    if (timings.length < 20) {
      return new Response(
        JSON.stringify({
          error:
            "This video has no word timings yet, so there is nothing to cut against. Render or re-render it once and the worker will align the narration.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Anthropic API key not configured. Add it in Settings > Secrets." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // The transcript is rebuilt from the timed words rather than taken from the script, so
    // every word Claude can quote is guaranteed to have a timestamp behind it.
    const transcript = timings.map((w) => w.w).join(" ");
    const totalSeconds = timings[timings.length - 1].e;

    const systemPrompt = `You cut long-form videos into vertical shorts for YouTube, TikTok and Reels.

A short works when it is complete on its own. It opens on something that makes scrolling feel like a mistake — a claim, a number, a contradiction — pays that off, and ends on a line that lands rather than trailing into the next sentence. A clip that starts mid-argument, or that depends on something explained five minutes earlier, fails no matter how good the writing is.

Pick moments that are genuinely the strongest in the video. Do not spread selections evenly across the runtime to be tidy, and do not pad the list to reach the requested count — returning three excellent clips is better than three excellent clips and two weak ones. Score honestly.

Quote the transcript exactly when marking where a clip starts and ends. The quotes are matched against the transcript word for word, so a paraphrase will land the cut in the wrong place.`;

    const userPrompt = `Find up to ${count} moments in this video that would work as standalone vertical shorts.

Video: ${title}
Niche: ${niche}
Runtime: ${Math.round(totalSeconds)} seconds

Each clip must run between ${minSeconds} and ${maxSeconds} seconds of speech. Clips must not overlap.

Transcript:
${transcript}`;

    const { text: raw, error: callError, refused } = await callAnthropic({
      apiKey,
      system: systemPrompt,
      prompt: userPrompt,
      outputConfig: {
        effort: "high",
        format: { type: "json_schema", schema: CLIPS_SCHEMA },
      },
    });

    if (refused) {
      return new Response(JSON.stringify({ error: "Claude declined to analyse this transcript." }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (callError || !raw) {
      return new Response(JSON.stringify({ error: callError ?? "No clips returned from Claude" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let parsed: { clips: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Response(JSON.stringify({ error: "Claude returned malformed clip JSON" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const flat = timings.map((w) => normalise(w.w)[0] ?? "");
    const skipped: string[] = [];

    const clips = (parsed.clips ?? [])
      .map((clip) => {
        const startIndex = findPhrase(flat, String(clip.quote_start ?? ""));
        if (startIndex < 0) {
          skipped.push(`"${clip.title}" — could not find its opening line in the transcript`);
          return null;
        }

        const endIndex = findPhrase(flat, String(clip.quote_end ?? ""), startIndex);
        if (endIndex < 0) {
          skipped.push(`"${clip.title}" — could not find its closing line after the opening one`);
          return null;
        }

        const endWords = normalise(String(clip.quote_end ?? "")).length;
        const last = Math.min(timings.length - 1, endIndex + Math.max(endWords - 1, 0));

        // A breath either side stops the cut clipping the first and last syllable.
        const start = Math.max(0, timings[startIndex].s - 0.25);
        const end = Math.min(totalSeconds, timings[last].e + 0.4);

        if (end - start < 5) {
          skipped.push(`"${clip.title}" — resolved to under 5 seconds, so the quotes probably matched the wrong place`);
          return null;
        }

        return {
          title: String(clip.title ?? "").slice(0, 200),
          reason: String(clip.reason ?? "").slice(0, 500),
          score: Math.max(0, Math.min(100, Number(clip.score ?? 0))),
          transcript: timings.slice(startIndex, last + 1).map((w) => w.w).join(" "),
          start_seconds: +start.toFixed(3),
          end_seconds: +end.toFixed(3),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a!.start_seconds - b!.start_seconds);

    return new Response(JSON.stringify({ clips, skipped }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
