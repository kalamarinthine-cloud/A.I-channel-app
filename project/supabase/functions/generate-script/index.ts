import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { title, niche, runtime, tone, instructions } = await req.json();

    if (!title) {
      return new Response(JSON.stringify({ error: "Title is required" }), {
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

    const runtimeGuidance: Record<string, string> = {
      "Short (<2 min)": "Keep it under 300 words. Fast-paced, punchy intro, one main point.",
      "Medium (2-8 min)": "Target 600-1200 words. Hook intro, 2-3 main sections, strong conclusion.",
      "Long (8-20 min)": "Target 1500-3500 words. Deep dive with multiple sections, examples, and analysis.",
    };

    const wordTarget = runtimeGuidance[runtime] ?? runtimeGuidance["Medium (2-8 min)"];

    const systemPrompt = `You are a professional YouTube script writer specializing in faceless channels. Write engaging, well-structured scripts that are ready for text-to-speech voiceover.

STRICT RULES:
- Write ONLY the spoken narration text — the words the narrator will read aloud.
- NEVER include visual cues, stage directions, camera notes, b-roll suggestions, or bracketed descriptions of what appears on screen.
- NEVER include instructions like [show footage of...] or [B-roll: ...] or [visual: ...].
- Use clear section headers in brackets like [INTRO], [SECTION 1: ...], [OUTRO] to structure the script — these are the ONLY bracketed elements allowed.
- Write in a conversational, natural speaking tone.`;

    const userPrompt = `Write a YouTube script for a faceless video.

Title: ${title}
Niche: ${niche}
Runtime: ${runtime}
Tone: ${tone || "informative and engaging"}
${instructions ? `Additional instructions: ${instructions}` : ""}

${wordTarget}

Format the script with clear section headers in brackets like [INTRO], [SECTION 1: ...], [SECTION 2: ...], [OUTRO]. Write ONLY the spoken narration text — no visual cues, no stage directions, no b-roll notes, no camera instructions. Just the words the narrator will say.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: `Anthropic request failed: ${response.status} — ${errText}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const script = data.content?.[0]?.text;

    if (!script) {
      return new Response(JSON.stringify({ error: "No script content returned from Claude" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ script }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
