import {
  supabase,
  enqueueRender,
  generateScript,
  generateMetadata,
  getRenderJob,
  listVoices,
  planBroll,
  type BrollAsset,
  type RenderJob,
  type Runtime,
  type ScriptProject,
} from '@/lib/supabase';

const STAGE_LABELS: Record<string, string> = {
  claimed: 'Worker picked up the job…',
  music: 'Composing background music…',
  voiceover: 'Narrating the script…',
  downloading: 'Downloading voiceover and clips…',
  rendering: 'Rendering with FFmpeg…',
  thumbnail: 'Composing the thumbnail…',
  publishing: 'Uploading to YouTube…',
  preview: 'Making a preview copy…',
  uploading: 'Saving the finished video…',
};

/**
 * Polls a render job to completion.
 *
 * There is no timeout here on purpose: a long video legitimately takes minutes, and the
 * job survives the page anyway. The queue's own `attempts` cap is what stops a genuinely
 * broken job from being retried forever.
 */
async function waitForRender(
  jobId: string,
  onUpdate: (job: RenderJob) => void,
): Promise<{ status: RenderJobStatusResult; error: string; thumbnail_url: string }> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    const job = await getRenderJob(jobId);
    if (!job) continue;

    onUpdate(job);

    if (job.status === 'done' || job.status === 'error') {
      return { status: job.status, error: job.error, thumbnail_url: job.thumbnail_url };
    }
  }
}

type RenderJobStatusResult = 'done' | 'error';

export type StepId = 'script' | 'metadata' | 'voiceover' | 'broll' | 'compile' | 'thumbnail';
export type StepStatus = 'pending' | 'running' | 'done' | 'error';

export interface PipelineStep {
  id: StepId;
  label: string;
  status: StepStatus;
  detail: string;
  /** 0-100, only meaningful while a step is running. */
  percent: number;
}

export interface PipelineState {
  steps: PipelineStep[];
  videoId: string | null;
  projectId: string | null;
  /** Set once the run stops for any reason. */
  finished: boolean;
  error: string | null;
  warnings: string[];
}

export interface ProduceOptions {
  title: string;
  niche: string;
  runtime: Runtime;
  tone?: string;
  instructions?: string;
  /** ElevenLabs voice. Falls back to the first voice on the account. */
  voiceId?: string;
  /** Publish to YouTube as soon as the render finishes. Off by default. */
  publishToYouTube?: boolean;
  privacyStatus?: 'private' | 'unlisted' | 'public';
  /** Background music bed under the narration. On by default. */
  musicEnabled?: boolean;
  musicPrompt?: string;
}

const STEP_LABELS: Record<StepId, string> = {
  script: 'Writing script',
  metadata: 'Generating title, description & tags',
  voiceover: 'Recording voiceover',
  broll: 'Sourcing B-roll',
  compile: 'Rendering video',
  thumbnail: 'Designing thumbnail',
};

const STEP_ORDER: StepId[] = ['script', 'metadata', 'voiceover', 'broll', 'compile', 'thumbnail'];

function initialState(): PipelineState {
  return {
    steps: STEP_ORDER.map((id) => ({ id, label: STEP_LABELS[id], status: 'pending', detail: '', percent: 0 })),
    videoId: null,
    projectId: null,
    finished: false,
    error: null,
    warnings: [],
  };
}

/**
 * Runs the whole faceless-video pipeline end to end: script, metadata, voice selection,
 * auto-sourced B-roll, then a queued render that narrates, cuts and optionally publishes.
 *
 * Every step writes its result to the database as soon as it succeeds, so a run that
 * fails halfway leaves a real project behind that can be finished by hand in the
 * Scripts / B-Roll / Assembly tabs rather than being lost.
 *
 * Nothing here holds the browser open past the hand-off: once the job is queued, the page
 * can be closed and the finished video will be waiting in Projects.
 */
export async function produceVideo(
  options: ProduceOptions,
  onUpdate: (state: PipelineState) => void,
): Promise<PipelineState> {
  const state = initialState();

  const emit = () => onUpdate({ ...state, steps: state.steps.map((s) => ({ ...s })) });

  const setStep = (id: StepId, patch: Partial<PipelineStep>) => {
    const step = state.steps.find((s) => s.id === id);
    if (step) Object.assign(step, patch);
    emit();
  };

  const fail = async (id: StepId, message: string) => {
    setStep(id, { status: 'error', detail: message });
    state.error = message;
    state.finished = true;
    if (state.projectId) {
      await supabase
        .from('script_projects')
        .update({ pipeline_status: 'error', pipeline_step: id, pipeline_error: message })
        .eq('id', state.projectId);
    }
    emit();
    return state;
  };

  emit();

  // ---------------------------------------------------------------- 1. Video row
  const { data: video, error: videoError } = await supabase
    .from('videos')
    .insert({
      title: options.title,
      niche: options.niche,
      runtime: options.runtime,
      status: 'idea',
      script_content: '',
      notes: '',
    })
    .select()
    .single();

  if (videoError || !video) {
    return fail('script', `Could not create the video record: ${videoError?.message ?? 'unknown error'}`);
  }
  state.videoId = video.id;
  emit();

  // ------------------------------------------------------------------ 2. Script
  setStep('script', { status: 'running', detail: 'Claude is drafting the narration…' });

  const { script, error: scriptError } = await generateScript({
    title: options.title,
    niche: options.niche,
    runtime: options.runtime,
    tone: options.tone,
    instructions: options.instructions,
  });

  if (scriptError || !script) {
    return fail('script', scriptError ?? 'No script was returned.');
  }

  const wordCount = script.trim().split(/\s+/).length;
  setStep('script', { status: 'done', detail: `${wordCount} words` });

  await supabase
    .from('videos')
    .update({ script_content: script, status: 'script_ready', updated_at: new Date().toISOString() })
    .eq('id', video.id);

  const { data: project, error: projectError } = await supabase
    .from('script_projects')
    .insert({
      video_id: video.id,
      script_content: script,
      script_tone: options.tone ?? '',
      script_instructions: options.instructions ?? '',
      auto_generated: true,
      pipeline_status: 'running',
      pipeline_step: 'script',
    })
    .select()
    .single();

  if (projectError || !project) {
    return fail('script', `Could not create the project record: ${projectError?.message ?? 'unknown error'}`);
  }
  state.projectId = project.id;
  emit();

  // ---------------------------------------------------------------- 3. Metadata
  setStep('metadata', { status: 'running', detail: 'Writing the YouTube listing…' });

  const { metadata, error: metadataError } = await generateMetadata({
    title: options.title,
    niche: options.niche,
    script,
  });

  if (metadataError || !metadata) {
    return fail('metadata', metadataError ?? 'No metadata was returned.');
  }

  await supabase
    .from('script_projects')
    .update({
      youtube_title: metadata.title,
      youtube_description: metadata.description,
      youtube_tags: metadata.tags,
      pipeline_step: 'metadata',
    })
    .eq('id', project.id);

  setStep('metadata', { status: 'done', detail: `"${metadata.title}" · ${metadata.tags.length} tags` });

  // ---------------------------------------------------------------- 4. Voice
  // Only the voice is chosen here. Narration itself happens on the worker: a long script
  // needs several sequential ElevenLabs calls, and an edge function gets killed part way
  // through for exceeding its wall-clock budget.
  setStep('voiceover', { status: 'running', detail: 'Selecting a voice…' });

  let voiceId = options.voiceId;
  if (!voiceId) {
    const { voices, error: voicesError } = await listVoices();
    if (voicesError || !voices || voices.length === 0) {
      return fail('voiceover', voicesError ?? 'No ElevenLabs voices are available on this account.');
    }
    voiceId = voices[0].voiceId;
  }

  await supabase
    .from('script_projects')
    .update({ voiceover_voice: voiceId, pipeline_step: 'voiceover' })
    .eq('id', project.id);

  setStep('voiceover', { status: 'done', detail: 'Voice selected — the worker will narrate' });

  // ------------------------------------------------------------------ 5. B-roll
  setStep('broll', { status: 'running', detail: 'Planning shots and searching Pexels…' });

  const { assets: planned, unmatched, error: brollError } = await planBroll({
    title: options.title,
    niche: options.niche,
    runtime: options.runtime,
    script,
  });

  if (brollError || !planned || planned.length === 0) {
    return fail('broll', brollError ?? 'No B-roll could be sourced.');
  }

  if (unmatched && unmatched.length > 0) {
    state.warnings.push(
      `${unmatched.length} shot${unmatched.length === 1 ? '' : 's'} had no stock match and were skipped: ${unmatched.join(', ')}`,
    );
  }

  const { data: insertedAssets, error: assetError } = await supabase
    .from('broll_assets')
    .insert(
      planned.map((asset) => ({
        video_id: video.id,
        label: asset.label,
        source_url: asset.videoUrl,
        type: 'footage',
        status: 'ready',
        beat_index: asset.beatIndex,
        search_query: asset.query,
      })),
    )
    .select();

  if (assetError || !insertedAssets) {
    return fail('broll', `Could not save the sourced clips: ${assetError?.message ?? 'unknown error'}`);
  }

  const orderedAssets = [...(insertedAssets as BrollAsset[])].sort(
    (a, b) => (a.beat_index ?? 0) - (b.beat_index ?? 0),
  );

  await supabase.from('script_projects').update({ pipeline_step: 'broll' }).eq('id', project.id);
  setStep('broll', { status: 'done', detail: `${orderedAssets.length} clips sourced` });

  // ------------------------------------------------------- 6 & 7. Render + thumbnail
  // Both happen in the worker, so these two steps are driven by one job's stage rather
  // than by two calls. Nothing here holds the browser open — closing the tab at this
  // point leaves the job running and the result lands in the project regardless.
  setStep('compile', { status: 'running', detail: 'Handing off to the render worker…', percent: 0 });

  await supabase
    .from('videos')
    .update({ status: 'editing', updated_at: new Date().toISOString() })
    .eq('id', video.id);

  const { job, error: enqueueError } = await enqueueRender({
    videoId: video.id,
    projectId: project.id,
    publishToYouTube: options.publishToYouTube,
    privacyStatus: options.privacyStatus,
    voiceId,
    musicEnabled: options.musicEnabled,
    musicPrompt: options.musicPrompt,
  });

  if (enqueueError || !job) {
    return fail('compile', enqueueError ?? 'Could not queue the render.');
  }

  const outcome = await waitForRender(job.id, (current) => {
    if (current.status === 'queued') {
      const waited = Date.now() - new Date(current.created_at).getTime();
      setStep('compile', {
        detail: waited > 45_000
          ? 'Still queued — is the render worker running?'
          : 'Queued, waiting for a worker…',
      });
      return;
    }

    if (current.stage === 'thumbnail' || current.stage === 'uploading') {
      setStep('compile', { status: 'done', detail: 'Render complete', percent: 100 });
      setStep('thumbnail', { status: 'running', detail: 'Worker is composing the thumbnail…' });
    } else {
      setStep('compile', { detail: STAGE_LABELS[current.stage] ?? 'Rendering…' });
    }
  });

  if (outcome.status !== 'done') {
    return fail('compile', outcome.error || 'The render job failed.');
  }

  await supabase.from('script_projects').update({ pipeline_step: 'compile' }).eq('id', project.id);
  setStep('compile', { status: 'done', detail: 'Render complete', percent: 100 });

  if (outcome.thumbnail_url) {
    setStep('thumbnail', { status: 'done', detail: '1280×720 thumbnail saved' });
  } else {
    state.warnings.push('The worker could not generate a thumbnail for this video.');
    setStep('thumbnail', { status: 'error', detail: 'Not generated' });
  }

  await supabase
    .from('script_projects')
    .update({ pipeline_status: 'done', pipeline_step: 'thumbnail', pipeline_error: '' })
    .eq('id', project.id);

  state.finished = true;
  emit();
  return state;
}

/** Reloads the project a finished run produced, for the review panel. */
export async function loadProject(projectId: string): Promise<ScriptProject | null> {
  const { data } = await supabase.from('script_projects').select('*').eq('id', projectId).maybeSingle();
  return (data as ScriptProject) ?? null;
}
