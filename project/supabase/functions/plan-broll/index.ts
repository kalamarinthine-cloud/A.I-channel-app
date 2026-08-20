import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { callAnthropic } from "../_shared/anthropic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

/**
 * How many distinct visual beats to cut the script into, by target runtime.
 * Roughly one clip every 8-12 seconds of narration.
 */
const BEAT_TARGETS: Record<string, number> = {
  "Short (<2 min)": 6,
  "Medium (2-8 min)": 12,
  "Long (8-20 min)": 20,
};

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    beats: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "Short human-readable name for what this shot shows, e.g. 'Server racks in a data center'.",
          },
          query: {
            type: "string",
            description:
              "A 2-4 word stock-footage search query for this shot. Concrete and filmable — 'city traffic at night', not 'economic uncertainty'.",
          },
        },
        required: ["label", "query"],
        additionalProperties: false,
      },
    },
  },
  required: ["beats"],
  additionalProperties: false,
};

interface Beat {
  label: string;
  query: string;
}

interface PexelsVideoFile {
  quality?: string;
  width?: number;
  link?: string;
}

interface PexelsVideo {
  id: number;
  duration: number;
  video_files?: PexelsVideoFile[];
  video_pictures?: Array<{ picture?: string }>;
}

/**
 * Picks the highest-quality file that isn't oversized — prefers HD around 1920px
 * so the canvas compiler doesn't have to decode 4K frames in the browser.
 */
function pickFile(files: PexelsVideoFile[] | undefined): string | null {
  if (!files || files.length === 0) return null;
  const sized = files.filter((f) => f.link && f.width);
  if (sized.length === 0) return files[0]?.link ?? null;
  const withinBudget = sized.filter((f) => (f.width ?? 0) <= 1920);
  const pool = withinBudget.length > 0 ? withinBudget : sized;
  pool.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return pool[0].link ?? null;
}

async function searchPexels(query: string, apiKey: string): Promise<PexelsVideo[]> {
  const res = await fetch(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape`,
    { headers: { Authorization: apiKey } },
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.videos ?? []) as PexelsVideo[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { title, niche, runtime, script } = await req.json();

    if (!script || script.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Script is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      return new Response(JSON.stringify({ error: "Anthropic API key not configured. Add it in Settings > Secrets." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const pexelsKey = Deno.env.get("PEXELS_API_KEY");
    if (!pexelsKey) {
      return new Response(JSON.stringify({ error: "Pexels API key not configured. Add it in Settings > Secrets." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const beatTarget = BEAT_TARGETS[runtime] ?? BEAT_TARGETS["Medium (2-8 min)"];

    const systemPrompt = `You are a video editor planning the B-roll for a faceless YouTube video. You read a narration script and decide what the viewer should be looking at, moment to moment.

Rules for search queries:
- Concrete and filmable. Stock libraries have "city traffic at night"; they do not have "economic uncertainty".
- 2-4 words. Longer queries return nothing.
- Vary them. Do not return the same query twice — repeated footage is what makes a video look cheap.
- Match the beat's meaning, not just its keywords.`;

    const userPrompt = `Plan the B-roll for this video.

Title: ${title}
Niche: ${niche}
Target runtime: ${runtime}

Cut the script into exactly ${beatTarget} sequential visual beats, in narration order. Each beat covers roughly an equal share of the script.

Script:
${String(script).slice(0, 20000)}`;

    const { text: raw, error: planError, refused } = await callAnthropic({
      apiKey: anthropicKey,
      system: systemPrompt,
      prompt: userPrompt,
      outputConfig: {
        effort: "medium",
        format: { type: "json_schema", schema: PLAN_SCHEMA },
      },
    });

    if (refused) {
      return new Response(JSON.stringify({ error: "Claude declined to plan B-roll for this script." }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (planError || !raw) {
      return new Response(JSON.stringify({ error: planError ?? "No B-roll plan returned from Claude" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let beats: Beat[];
    try {
      beats = (JSON.parse(raw).beats ?? []) as Beat[];
    } catch {
      return new Response(JSON.stringify({ error: "Claude returned a malformed B-roll plan" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (beats.length === 0) {
      return new Response(JSON.stringify({ error: "Claude returned an empty B-roll plan" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Source every beat concurrently, then de-duplicate: the same stock clip
    // showing up twice is the most visible failure mode of auto-sourced B-roll.
    const searches = await Promise.all(beats.map((beat) => searchPexels(beat.query, pexelsKey)));

    const usedIds = new Set<number>();
    const assets: Array<{
      beatIndex: number;
      label: string;
      query: string;
      videoUrl: string;
      thumbnail: string | null;
      duration: number;
    }> = [];
    const unmatched: string[] = [];

    beats.forEach((beat, index) => {
      const candidates = searches[index];
      const pick = candidates.find((v) => !usedIds.has(v.id) && pickFile(v.video_files));

      if (!pick) {
        unmatched.push(beat.query);
        return;
      }

      const videoUrl = pickFile(pick.video_files);
      if (!videoUrl) {
        unmatched.push(beat.query);
        return;
      }

      usedIds.add(pick.id);
      assets.push({
        beatIndex: index,
        label: beat.label,
        query: beat.query,
        videoUrl,
        thumbnail: pick.video_pictures?.[0]?.picture ?? null,
        duration: pick.duration,
      });
    });

    if (assets.length === 0) {
      return new Response(
        JSON.stringify({ error: "No stock footage matched any beat of the plan. Try a different title or niche." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ assets, unmatched }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
