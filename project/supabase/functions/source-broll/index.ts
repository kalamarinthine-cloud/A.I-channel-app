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
    const { query, perPage } = await req.json();

    if (!query || query.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Search query is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("PEXELS_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Pexels API key not configured. Add it in Settings > Secrets." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const response = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage || 8}&orientation=landscape`,
      {
        headers: {
          Authorization: apiKey,
        },
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: `Pexels request failed: ${response.status} — ${errText}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const videos = (data.videos ?? []).map((v: Record<string, unknown>) => {
      const files = v.video_files as Array<Record<string, unknown>> | undefined;
      const bestFile = files?.find((f) => f.quality === "hd") ?? files?.[0];
      const pictures = v.video_pictures as Array<Record<string, unknown>> | undefined;
      return {
        id: v.id,
        width: v.width,
        height: v.height,
        duration: v.duration,
        thumbnail: pictures?.[0]?.picture ?? null,
        videoUrl: bestFile?.link ?? null,
      };
    });

    return new Response(JSON.stringify({ results: videos }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
