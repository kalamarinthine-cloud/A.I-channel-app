import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type VideoStatus = 'idea' | 'script_ready' | 'recording' | 'editing' | 'published';
export type Runtime = 'Short (<2 min)' | 'Medium (2-8 min)' | 'Long (8-20 min)';

export interface Video {
  id: string;
  title: string;
  niche: string;
  runtime: Runtime;
  status: VideoStatus;
  script_content: string;
  notes: string;
  voiceover_url: string;
  voiceover_voice: string;
  created_at: string;
  updated_at: string;
}

export type AssetType = 'footage' | 'image' | 'screen_recording' | 'music' | 'sfx';
export type AssetStatus = 'needed' | 'sourced' | 'ready';

export interface BrollAsset {
  id: string;
  video_id: string;
  label: string;
  source_url: string;
  type: AssetType;
  status: AssetStatus;
  beat_index: number | null;
  search_query: string;
  created_at: string;
}

export type YoutubeStatus = '' | 'uploading' | 'uploaded' | 'failed';
export type PipelineStatus = '' | 'running' | 'done' | 'error';

export interface ScriptProject {
  id: string;
  video_id: string;
  script_content: string;
  script_tone: string;
  script_instructions: string;
  voiceover_url: string;
  voiceover_voice: string;
  compiled_video_url: string;
  /** True when the stored file is the downscaled preview rather than the master. */
  compiled_is_preview: boolean;
  youtube_title: string;
  youtube_description: string;
  youtube_tags: string[];
  thumbnail_url: string;
  youtube_video_id: string;
  youtube_status: YoutubeStatus;
  pipeline_status: PipelineStatus;
  pipeline_step: string;
  pipeline_error: string;
  auto_generated: boolean;
  created_at: string;
}

export const STATUS_ORDER: VideoStatus[] = ['idea', 'script_ready', 'recording', 'editing', 'published'];

export const STATUS_LABELS: Record<VideoStatus, string> = {
  idea: 'Idea',
  script_ready: 'Script Ready',
  recording: 'Recording',
  editing: 'Editing',
  published: 'Published',
};

export const STATUS_COLORS: Record<VideoStatus, string> = {
  idea: 'bg-ink-600 text-slate-300',
  script_ready: 'bg-brand-600 text-white',
  recording: 'bg-warning-500 text-white',
  editing: 'bg-accent-500 text-ink-950',
  published: 'bg-success-500 text-white',
};

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  footage: 'Footage',
  image: 'Image',
  screen_recording: 'Screen Recording',
  music: 'Music',
  sfx: 'Sound Effect',
};

export const ASSET_STATUS_COLORS: Record<AssetStatus, string> = {
  needed: 'bg-error-500 text-white',
  sourced: 'bg-brand-600 text-white',
  ready: 'bg-success-500 text-white',
};

export const RUNTIME_OPTIONS: Runtime[] = ['Short (<2 min)', 'Medium (2-8 min)', 'Long (8-20 min)'];

export interface ElevenVoice {
  voiceId: string;
  name: string;
  category: string;
  labels?: Record<string, string>;
}

export interface BrollSearchResult {
  id: number;
  width: number;
  height: number;
  duration: number;
  thumbnail: string | null;
  videoUrl: string | null;
}

function edgeUrl(slug: string): string {
  return `${supabaseUrl}/functions/v1/${slug}`;
}

function edgeHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${supabaseAnonKey}`,
    'Content-Type': 'application/json',
  };
}

export async function generateScript(params: {
  title: string;
  niche: string;
  runtime: Runtime;
  tone?: string;
  instructions?: string;
}): Promise<{ script?: string; error?: string }> {
  try {
    const res = await fetch(edgeUrl('generate-script'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error ?? 'Script generation failed' };
    return { script: data.script };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function searchBroll(params: {
  query: string;
  perPage?: number;
}): Promise<{ results?: BrollSearchResult[]; error?: string }> {
  try {
    const res = await fetch(edgeUrl('source-broll'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error ?? 'B-roll search failed' };
    return { results: data.results };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function listVoices(): Promise<{ voices?: ElevenVoice[]; error?: string }> {
  try {
    const res = await fetch(edgeUrl('list-voices'), {
      method: 'POST',
      headers: edgeHeaders(),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error ?? 'Failed to load voices' };
    return { voices: data.voices };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function generateVoiceover(params: {
  text: string;
  voiceId: string;
  videoId: string;
}): Promise<{ url?: string; error?: string }> {
  try {
    const res = await fetch(edgeUrl('text-to-speech'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? `Voiceover failed (${res.status})` };
    return { url: data.url };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

/**
 * Turns a Storage URL into one that actually downloads.
 *
 * An `<a download>` attribute is ignored for cross-origin URLs, and the app and Storage are
 * always different origins — so the browser navigates to the file and plays it inline
 * instead. Supabase's `?download=` parameter sets `Content-Disposition: attachment`, which
 * works regardless of origin and names the saved file.
 *
 * The extension is taken from the URL rather than assumed, so a name can't claim `.webm`
 * for what is now an `.mp4`.
 */
export function downloadUrl(url: string, baseName: string): string {
  if (!url) return url;
  const withoutQuery = url.split('?')[0];
  const ext = withoutQuery.includes('.') ? withoutQuery.split('.').pop()! : '';
  const safeBase = baseName.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-') || 'download';
  const filename = ext ? `${safeBase}.${ext}` : safeBase;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}download=${encodeURIComponent(filename)}`;
}

export type RenderJobStatus = 'queued' | 'rendering' | 'done' | 'error';

export interface RenderJob {
  id: string;
  video_id: string;
  project_id: string;
  status: RenderJobStatus;
  /** Coarse progress from the worker: downloading, rendering, publishing, uploading. */
  stage: string;
  attempts: number;
  error: string;
  output_url: string;
  thumbnail_url: string;
  publish_to_youtube: boolean;
  privacy_status: 'private' | 'unlisted' | 'public';
  youtube_video_id: string;
  /** A failed publish doesn't fail the job — the render still succeeded. */
  publish_error: string;
  worker_id: string;
  claimed_at: string | null;
  created_at: string;
  finished_at: string | null;
}

/** Hands a video off to the render worker. Returns immediately — rendering is out of process. */
export async function enqueueRender(params: {
  videoId: string;
  projectId: string;
  /** Opt-in. Publishing is outward-facing and each upload costs 1,600 daily quota units. */
  publishToYouTube?: boolean;
  privacyStatus?: 'private' | 'unlisted' | 'public';
}): Promise<{ job?: RenderJob; error?: string }> {
  const { data, error } = await supabase
    .from('render_jobs')
    .insert({
      video_id: params.videoId,
      project_id: params.projectId,
      publish_to_youtube: params.publishToYouTube ?? false,
      privacy_status: params.privacyStatus ?? 'private',
    })
    .select()
    .single();

  if (error) return { error: error.message };
  return { job: data as RenderJob };
}

export async function getRenderJob(jobId: string): Promise<RenderJob | null> {
  const { data } = await supabase.from('render_jobs').select('*').eq('id', jobId).maybeSingle();
  return (data as RenderJob) ?? null;
}

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
}

export async function generateMetadata(params: {
  title: string;
  niche: string;
  script: string;
}): Promise<{ metadata?: VideoMetadata; error?: string }> {
  try {
    const res = await fetch(edgeUrl('generate-metadata'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? `Metadata generation failed (${res.status})` };
    return { metadata: data.metadata };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

export interface PlannedAsset {
  beatIndex: number;
  label: string;
  query: string;
  videoUrl: string;
  thumbnail: string | null;
  duration: number;
}

export async function planBroll(params: {
  title: string;
  niche: string;
  runtime: Runtime;
  script: string;
}): Promise<{ assets?: PlannedAsset[]; unmatched?: string[]; error?: string }> {
  try {
    const res = await fetch(edgeUrl('plan-broll'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? `B-roll planning failed (${res.status})` };
    return { assets: data.assets, unmatched: data.unmatched };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function uploadToYouTube(params: {
  projectId: string;
  videoUrl: string;
  thumbnailUrl?: string;
  title: string;
  description: string;
  tags: string[];
  privacyStatus: 'private' | 'unlisted' | 'public';
}): Promise<{ youtubeVideoId?: string; error?: string }> {
  try {
    const res = await fetch(edgeUrl('youtube-upload'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? `YouTube upload failed (${res.status})` };
    return { youtubeVideoId: data.youtubeVideoId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}
