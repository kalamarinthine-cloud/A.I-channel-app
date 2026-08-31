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
  music_url: string;
  music_prompt: string;
  /** Where the full-quality render sits on the worker's disk. Clips are cut from it. */
  master_path: string;
  /** When each narrated word is spoken, which is what captions are timed against. */
  word_timings: Array<{ w: string; s: number; e: number }>;
  /** Set to ask the worker to align an older voiceover that has no timings yet. */
  align_requested: boolean;
  /** Why the last alignment failed. Alignment runs on the worker, so without this the
   *  app cannot tell a failure apart from work still in progress. */
  align_error: string;
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

/**
 * Where a clip's files sit in the `clips` bucket.
 *
 * The worker writes both under the video's folder, named for the clip, so the paths can be
 * derived from the row rather than parsed back out of the public URLs — which are empty
 * until a clip has rendered.
 */
export function clipStoragePaths(clip: Pick<Clip, 'id' | 'video_id'>): string[] {
  return [`${clip.video_id}/${clip.id}.mp4`, `${clip.video_id}/${clip.id}.jpg`];
}

/**
 * Deletes a clip and the files behind it.
 *
 * Storage has no foreign keys, so removing the row alone leaves the video and its poster in
 * the bucket with nothing left pointing at them: unreachable from the app, but still stored
 * and still counted. They have to go first, while the row still says where they are.
 *
 * `remove` takes the whole list in one request. That matters — deleting these one path at a
 * time is rejected, and the bulk form is the only one that works. A clip that never
 * rendered has no files, and removing paths that do not exist is not an error.
 *
 * A storage failure must not block the row. Leaving an undeletable clip in the list would
 * be worse than leaving a file in a bucket, so the row goes either way and the caller is
 * told what was left behind.
 */
export async function deleteClip(clip: Pick<Clip, 'id' | 'video_id'>): Promise<{ error?: string }> {
  const { error: storageError } = await supabase.storage.from('clips').remove(clipStoragePaths(clip));

  const { error } = await supabase.from('clips').delete().eq('id', clip.id);
  if (error) return { error: `Could not delete this clip: ${error.message}` };

  if (storageError) {
    return { error: `Clip deleted, but its files are still in storage: ${storageError.message}` };
  }
  return {};
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
  music_enabled: boolean;
  music_prompt: string;
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
  /** Only used when the project has no voiceover yet; the worker narrates it. */
  voiceId?: string;
  /** Background music bed, ducked under the narration. On by default. */
  musicEnabled?: boolean;
  /** Overrides the niche default mood for this job. */
  musicPrompt?: string;
}): Promise<{ job?: RenderJob; error?: string }> {
  const { data, error } = await supabase
    .from('render_jobs')
    .insert({
      video_id: params.videoId,
      project_id: params.projectId,
      publish_to_youtube: params.publishToYouTube ?? false,
      privacy_status: params.privacyStatus ?? 'private',
      voice_id: params.voiceId ?? '',
      music_enabled: params.musicEnabled ?? true,
      music_prompt: params.musicPrompt ?? '',
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

/* ---------------------------------------------------------------- clips --- */

export type ClipStatus = 'proposed' | 'queued' | 'rendering' | 'ready' | 'error';
export type CaptionStyle = 'bold' | 'karaoke' | 'minimal' | 'boxed' | 'none';
export type Reframe = 'crop' | 'blur';

export interface Clip {
  id: string;
  video_id: string;
  project_id: string;
  title: string;
  reason: string;
  score: number;
  transcript: string;
  start_seconds: number;
  end_seconds: number;
  caption_style: CaptionStyle;
  reframe: Reframe;
  status: ClipStatus;
  stage: string;
  attempts: number;
  error: string;
  output_url: string;
  thumbnail_url: string;
  duration_seconds: number;
  publish_to_youtube: boolean;
  privacy_status: 'private' | 'unlisted' | 'public';
  youtube_video_id: string;
  publish_error: string;
  created_at: string;
  finished_at: string | null;
}

/** Mirrors the presets the worker knows about in captions.js. */
export const CAPTION_STYLE_OPTIONS: Array<{ id: CaptionStyle; label: string; description: string }> = [
  { id: 'bold', label: 'Bold', description: 'Big uppercase, active word in yellow' },
  { id: 'karaoke', label: 'Karaoke', description: 'Words light up in cyan as spoken' },
  { id: 'minimal', label: 'Minimal', description: 'Clean sentence case, no highlight' },
  { id: 'boxed', label: 'Boxed', description: 'White text on a solid bar' },
  { id: 'none', label: 'None', description: 'No captions' },
];

export const REFRAME_OPTIONS: Array<{ id: Reframe; label: string; description: string }> = [
  { id: 'crop', label: 'Fill', description: 'Crop the sides away for a full-bleed frame' },
  { id: 'blur', label: 'Fit', description: 'Whole frame, blurred fill above and below' },
];

export const CLIP_STAGE_LABELS: Record<string, string> = {
  claimed: 'Worker picked it up…',
  sourcing: 'Finding the source video…',
  captions: 'Timing the captions…',
  rendering: 'Cutting and captioning…',
  publishing: 'Publishing to YouTube…',
  uploading: 'Saving the clip…',
  done: 'Done',
};

export interface ProposedClip {
  title: string;
  reason: string;
  score: number;
  transcript: string;
  start_seconds: number;
  end_seconds: number;
}

/**
 * Asks Claude for the moments worth cutting. Returns proposals only — nothing is written
 * or rendered until they are saved, so re-running this is cheap and discards nothing.
 */
export async function findClips(params: {
  title: string;
  niche: string;
  words: Array<{ w: string; s: number; e: number }>;
  count?: number;
}): Promise<{ clips?: ProposedClip[]; skipped?: string[]; error?: string }> {
  try {
    const res = await fetch(edgeUrl('find-clips'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? `Clip search failed (${res.status})` };
    return { clips: data.clips, skipped: data.skipped };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}
