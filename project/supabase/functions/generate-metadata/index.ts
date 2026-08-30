import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { callAnthropic } from "../_shared/anthropic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const METADATA_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "YouTube-ready title, under 70 characters, curiosity-driven but not clickbait-dishonest.",
    },
    description: {
      type: "string",
      description:
        "YouTube description: a 1-2 sentence hook, a short summary paragraph covering what the video explains, then a call to action. Never include chapter timestamps — the video's runtime is not known when this is written, so any timestamps would be invented.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "10-15 lowercase YouTube tags, most specific first.",
    },
  },
  required: ["title", "description", "tags"],
  additionalProperties: false,
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { title, niche, script } = await req.json();

    if (!script || script.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Script is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Anthropic API key not configured. Add it in Settings > Secrets." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const systemPrompt = `You write YouTube metadata for faceless channels. You write titles that earn the click honestly — the video genuinely delivers what the title promises. Descriptions are skimmable and front-load the value. Tags are what a real viewer would actually type into search.

You are writing from the script alone, before the video has been narrated or cut, so you do not know its runtime. Leave chapter timestamps out of the description entirely. YouTube turns a list beginning at 0:00 into real chapters, so guessed times send viewers to the wrong place — or past the end of the video.`;

    const userPrompt = `Write the YouTube metadata for this video.

Working title: ${title}
Niche: ${niche}

Script:
${String(script).slice(0, 20000)}`;

    const { text: raw, error: callError, refused } = await callAnthropic({
      apiKey,
      system: systemPrompt,
      prompt: userPrompt,
      outputConfig: {
        effort: "medium",
        format: { type: "json_schema", schema: METADATA_SCHEMA },
      },
    });

    if (refused) {
      return new Response(JSON.stringify({ error: "Claude declined to generate metadata for this script." }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (callError || !raw) {
      return new Response(JSON.stringify({ error: callError ?? "No metadata returned from Claude" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let metadata: { title: string; description: string; tags: string[] };
    try {
      metadata = JSON.parse(raw);
    } catch {
      return new Response(JSON.stringify({ error: "Claude returned malformed metadata JSON" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ metadata }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
