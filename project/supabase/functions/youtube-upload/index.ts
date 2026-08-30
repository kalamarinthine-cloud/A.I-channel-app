import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// YouTube Data API limits. Exceeding any of these rejects the whole insert,
// so clamp here rather than letting a long AI-written description fail the upload.
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 5000;
const MAX_TAGS_CHARS = 480;

/** "People & Blogs" — a safe default that never fails validation. */
const DEFAULT_CATEGORY_ID = "22";

function clampTags(tags: string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const tag of tags) {
    const cost = tag.length + 1;
    if (used + cost > MAX_TAGS_CHARS) break;
    out.push(tag);
    used += cost;
  }
  return out;
}

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("YOUTUBE_CLIENT_ID");
  const clientSecret = Deno.env.get("YOUTUBE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("YOUTUBE_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "YouTube is not connected. Add YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN in Settings > Secrets.",
    );
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Could not refresh the YouTube access token: ${res.status} — ${errText}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error("Google returned no access token.");
  return data.access_token as string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { videoUrl, thumbnailUrl, title, description, tags, privacyStatus } = await req.json();

    if (!videoUrl) {
      return new Response(JSON.stringify({ error: "videoUrl is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!title) {
      return new Response(JSON.stringify({ error: "title is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accessToken = await getAccessToken();

    // Fetch the compiled video. Its body is streamed straight into the upload so the
    // whole file never has to sit in the edge function's memory at once.
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok || !videoResponse.body) {
      return new Response(JSON.stringify({ error: `Could not read the compiled video (${videoResponse.status})` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const contentLength = videoResponse.headers.get("content-length");
    const contentType = videoResponse.headers.get("content-type") ?? "video/webm";

    if (!contentLength) {
      return new Response(
        JSON.stringify({ error: "Storage did not report the video size, which YouTube's resumable upload requires." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Step 1 — open a resumable upload session.
    const initResponse = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": contentType,
          "X-Upload-Content-Length": contentLength,
        },
        body: JSON.stringify({
          snippet: {
            title: String(title).slice(0, MAX_TITLE),
            description: String(description ?? "").slice(0, MAX_DESCRIPTION),
            tags: clampTags(Array.isArray(tags) ? tags : []),
            categoryId: DEFAULT_CATEGORY_ID,
          },
          status: {
            privacyStatus: privacyStatus ?? "private",
            selfDeclaredMadeForKids: false,
          },
        }),
      },
    );

    if (!initResponse.ok) {
      const errText = await initResponse.text();
      return new Response(JSON.stringify({ error: `YouTube rejected the upload session: ${initResponse.status} — ${errText}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const uploadUrl = initResponse.headers.get("location");
    if (!uploadUrl) {
      return new Response(JSON.stringify({ error: "YouTube did not return an upload URL." }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 2 — send the bytes.
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": contentType,
        "Content-Length": contentLength,
      },
      body: videoResponse.body,
    });

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      return new Response(JSON.stringify({ error: `YouTube upload failed: ${uploadResponse.status} — ${errText}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const uploaded = await uploadResponse.json();
    const youtubeVideoId = uploaded.id as string | undefined;

    if (!youtubeVideoId) {
      return new Response(JSON.stringify({ error: "YouTube did not return a video ID." }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 3 — set the custom thumbnail. The video is already live at this point, so a
    // thumbnail failure is reported as a warning rather than failing the whole upload.
    let thumbnailWarning: string | null = null;
    if (thumbnailUrl) {
      try {
        const thumbResponse = await fetch(thumbnailUrl);
        if (!thumbResponse.ok) throw new Error(`could not read the thumbnail (${thumbResponse.status})`);
        const thumbBytes = await thumbResponse.arrayBuffer();

        const setThumb = await fetch(
          `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${youtubeVideoId}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "image/png",
            },
            body: thumbBytes,
          },
        );

        if (!setThumb.ok) {
          const errText = await setThumb.text();
          throw new Error(`${setThumb.status} — ${errText}`);
        }
      } catch (err) {
        thumbnailWarning = `Video uploaded, but the thumbnail could not be set: ${err.message}. Custom thumbnails require a verified YouTube account.`;
      }
    }

    return new Response(JSON.stringify({ youtubeVideoId, thumbnailWarning }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
