import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

// YouTube rejects the whole insert if any of these are exceeded, so clamp rather than
// letting a long AI-written description fail an upload that already cost a render.
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 5000;
const MAX_TAGS_CHARS = 480;

/** "People & Blogs" — a category that never fails validation. */
const DEFAULT_CATEGORY_ID = '22';

export function hasCredentials() {
  return Boolean(
    process.env.YOUTUBE_CLIENT_ID &&
    process.env.YOUTUBE_CLIENT_SECRET &&
    process.env.YOUTUBE_REFRESH_TOKEN,
  );
}

function clampTags(tags) {
  const out = [];
  let used = 0;
  for (const tag of tags || []) {
    const cost = String(tag).length + 1;
    if (used + cost > MAX_TAGS_CHARS) break;
    out.push(tag);
    used += cost;
  }
  return out;
}

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID,
      client_secret: process.env.YOUTUBE_CLIENT_SECRET,
      refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    // invalid_grant is by far the most common failure and its message says nothing useful.
    if (text.includes('invalid_grant')) {
      throw new Error(
        'YouTube refresh token rejected (invalid_grant). This usually means the token was ' +
        'minted while the Google Cloud app was still in Testing, which expires it after 7 days. ' +
        'Publish the app to production, then mint a new refresh token.',
      );
    }
    throw new Error(`Could not refresh the YouTube access token: ${res.status} — ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error('Google returned no access token.');
  return data.access_token;
}

/**
 * Uploads a local file to YouTube using a resumable session.
 *
 * The file is streamed off disk rather than buffered, so a twenty-minute render doesn't
 * have to fit in memory. This is the whole point of publishing from the worker: it already
 * has the bytes, so nothing has to pass through Storage and its per-file size limit.
 */
export async function uploadVideo({ filePath, title, description, tags, privacyStatus, onProgress }) {
  const accessToken = await getAccessToken();
  const { size } = await stat(filePath);

  if (onProgress) onProgress(`opening upload session (${(size / 1024 / 1024).toFixed(1)} MB)`);

  const initResponse = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify({
        snippet: {
          title: String(title || 'Untitled').slice(0, MAX_TITLE),
          description: String(description || '').slice(0, MAX_DESCRIPTION),
          tags: clampTags(tags),
          categoryId: DEFAULT_CATEGORY_ID,
        },
        status: {
          privacyStatus: privacyStatus || 'private',
          selfDeclaredMadeForKids: false,
        },
      }),
    },
  );

  if (!initResponse.ok) {
    const text = await initResponse.text();
    if (initResponse.status === 403 && text.includes('quota')) {
      throw new Error(
        'YouTube daily quota exceeded. An upload costs 1,600 of 10,000 units, so roughly ' +
        'six per day. The counter resets at midnight Pacific.',
      );
    }
    throw new Error(`YouTube rejected the upload session: ${initResponse.status} — ${text}`);
  }

  const uploadUrl = initResponse.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube did not return an upload URL.');

  if (onProgress) onProgress('uploading');

  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'video/mp4',
      'Content-Length': String(size),
    },
    body: Readable.toWeb(createReadStream(filePath)),
    // Required by undici when the body is a stream — without it the request is rejected
    // before a single byte leaves the process.
    duplex: 'half',
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`YouTube upload failed: ${uploadResponse.status} — ${text}`);
  }

  const uploaded = await uploadResponse.json();
  if (!uploaded.id) throw new Error('YouTube did not return a video ID.');
  return uploaded.id;
}

/**
 * Sets the custom thumbnail. Separate from uploadVideo because the video is already live
 * by this point — a thumbnail failure is a warning, not a failed publish. Custom
 * thumbnails also require a phone-verified channel, which is a common reason for this
 * step alone to fail.
 */
export async function setThumbnail({ videoId, filePath }) {
  const accessToken = await getAccessToken();
  const bytes = await readFile(filePath);

  const res = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'image/jpeg',
      },
      body: bytes,
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} — ${text}`);
  }
}
