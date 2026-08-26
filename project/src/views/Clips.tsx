import {
  downloadUrl,
  findClips,
  supabase,
  CAPTION_STYLE_OPTIONS,
  CLIP_STAGE_LABELS,
  REFRAME_OPTIONS,
  type CaptionStyle,
  type Clip,
  type ProposedClip,
  type Reframe,
  type ScriptProject,
  type Video,
} from '@/lib/supabase';
import {
  AlertCircle,
  Check,
  Download,
  ExternalLink,
  Film,
  Loader2,
  Scissors,
  Sparkles,
  Trash2,
  Wand2,
  Youtube,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface ClipsProps {
  onRefresh: () => void;
}

/** The project fields this view needs, deliberately without the bulky word_timings. */
type ProjectSummary = Pick<
  ScriptProject,
  'id' | 'video_id' | 'voiceover_url' | 'compiled_video_url' | 'master_path' | 'align_requested' | 'align_error'
>;

/** mm:ss, which is how you think about a position in a video. */
function timecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Parses "1:23" or "83" back into seconds, returning null for anything else. */
function parseTimecode(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  if (parts.length > 2 || parts.some((p) => p !== '' && !/^\d*\.?\d*$/.test(p))) return null;
  const seconds = parts.length === 2
    ? Number(parts[0] || 0) * 60 + Number(parts[1] || 0)
    : Number(parts[0]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export default function Clips({ onRefresh }: ClipsProps) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [words, setWords] = useState<Array<{ w: string; s: number; e: number }>>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [busyClipId, setBusyClipId] = useState<string | null>(null);
  const [alignAsked, setAlignAsked] = useState(false);

  // Defaults applied to every clip found in the next search, so a whole batch can be
  // styled once rather than one card at a time.
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>('bold');
  const [reframe, setReframe] = useState<Reframe>('crop');

  /**
   * Everything except the timings.
   *
   * word_timings holds one row per spoken word — a few thousand for a twenty-minute video —
   * so selecting it for every project pulls megabytes of JSON on each poll and locks the
   * page up while it parses. The timings are only ever needed for the one selected project,
   * and are fetched separately below.
   */
  const load = useCallback(async () => {
    const [{ data: v }, { data: p }, { data: c }] = await Promise.all([
      supabase.from('videos').select('*').order('updated_at', { ascending: false }),
      supabase
        .from('script_projects')
        .select('id,video_id,voiceover_url,compiled_video_url,master_path,align_requested,align_error')
        .order('created_at', { ascending: false }),
      supabase.from('clips').select('*').order('start_seconds'),
    ]);
    setVideos(v ?? []);
    setProjects((p ?? []) as ProjectSummary[]);
    setClips((c ?? []) as Clip[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Only videos that have actually been rendered can be cut up.
  const clippable = videos.filter((v) =>
    projects.some((p) => p.video_id === v.id && (p.compiled_video_url || p.master_path)));

  useEffect(() => {
    if (!selectedId && clippable.length > 0) setSelectedId(clippable[0].id);
  }, [clippable, selectedId]);

  const selected = videos.find((v) => v.id === selectedId) ?? null;
  const project = projects.find((p) => p.video_id === selectedId) ?? null;
  const videoClips = clips.filter((c) => c.video_id === selectedId);
  const wordCount = words.length;
  // Alignment has no status of its own: the request flag is cleared the moment the worker
  // claims it, so "in progress" is the window between asking and the timings appearing.
  const alignError = project?.align_error ?? '';
  const aligning =
    !!project && wordCount === 0 && !alignError && (project.align_requested || alignAsked);
  const working =
    aligning || videoClips.some((c) => c.status === 'queued' || c.status === 'rendering');

  // Poll only while something is actually being cut, then stop.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => { loadRef.current(); }, 3000);
    return () => clearInterval(timer);
  }, [working]);

  // Timings for the selected project only, refetched while an alignment is running so the
  // view flips to "Find clips" as soon as they land.
  const projectId = project?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!projectId) { setWords([]); return; }
    supabase
      .from('script_projects')
      .select('word_timings')
      .eq('id', projectId)
      .single()
      .then(({ data }) => {
        if (!cancelled) setWords((data?.word_timings ?? []) as Array<{ w: string; s: number; e: number }>);
      });
    return () => { cancelled = true; };
  }, [projectId, projects]);

  const handleAlign = async () => {
    if (!project) return;
    setAlignAsked(true);
    setError('');
    await supabase
      .from('script_projects')
      .update({ align_requested: true, align_error: '' })
      .eq('id', project.id);
    await load();
  };

  const handleFind = async () => {
    if (!selected || !project || finding) return;
    setFinding(true);
    setError('');
    setNotes([]);

    const { clips: found, skipped, error: findError } = await findClips({
      title: selected.title,
      niche: selected.niche,
      words,
      count: 5,
    });

    if (findError || !found) {
      setError(findError ?? 'No clips came back.');
      setFinding(false);
      return;
    }

    if (found.length === 0) {
      setError('Claude did not find a moment in this video that stands alone as a short.');
      setFinding(false);
      return;
    }

    const rows = found.map((c: ProposedClip) => ({
      video_id: selected.id,
      project_id: project.id,
      title: c.title,
      reason: c.reason,
      score: c.score,
      transcript: c.transcript,
      start_seconds: c.start_seconds,
      end_seconds: c.end_seconds,
      caption_style: captionStyle,
      reframe,
      status: 'proposed',
    }));

    const { error: insertError } = await supabase.from('clips').insert(rows);
    if (insertError) setError(insertError.message);
    if (skipped && skipped.length > 0) setNotes(skipped);

    await load();
    setFinding(false);
  };

  const patchClip = async (clip: Clip, patch: Partial<Clip>) => {
    setClips((current) => current.map((c) => (c.id === clip.id ? { ...c, ...patch } : c)));
    await supabase.from('clips').update(patch).eq('id', clip.id);
  };

  const handleRender = async (clip: Clip) => {
    setBusyClipId(clip.id);
    // attempts resets so a clip that failed three times can be retried after a fix.
    await supabase
      .from('clips')
      .update({ status: 'queued', stage: '', error: '', attempts: 0 })
      .eq('id', clip.id);
    await load();
    setBusyClipId(null);
    onRefresh();
  };

  const handleDelete = async (clip: Clip) => {
    setBusyClipId(clip.id);
    await supabase.from('clips').delete().eq('id', clip.id);
    await load();
    setBusyClipId(null);
  };

  if (loading) {
    return (
      <div className="space-y-6 animate-fade-in">
        <Header />
        <p className="text-sm text-slate-400 py-8 text-center">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <Header />

      {clippable.length === 0 ? (
        <div className="text-center py-16">
          <Scissors className="w-12 h-12 text-ink-600 mx-auto mb-4" />
          <p className="text-sm text-slate-400 mb-1">Nothing to clip yet</p>
          <p className="text-xs text-ink-500">Render a video first — clips are cut out of a finished one.</p>
        </div>
      ) : (
        <>
          {/* Source video and the settings applied to the next search */}
          <div className="bg-ink-850 border border-ink-700 rounded-xl p-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">
                Source video
              </label>
              <select
                value={selectedId ?? ''}
                onChange={(e) => { setSelectedId(e.target.value); setError(''); setNotes([]); setAlignAsked(false); }}
                className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500"
              >
                {clippable.map((v) => (
                  <option key={v.id} value={v.id}>{v.title}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Choice
                label="Caption style"
                value={captionStyle}
                options={CAPTION_STYLE_OPTIONS}
                onChange={(v) => setCaptionStyle(v as CaptionStyle)}
              />
              <Choice
                label="Framing"
                value={reframe}
                options={REFRAME_OPTIONS}
                onChange={(v) => setReframe(v as Reframe)}
              />
            </div>

            <div className="flex items-center justify-between gap-4 pt-1">
              <p className="text-xs text-ink-500">
                {wordCount > 0
                  ? `${wordCount} words timed — captions will match the narration.`
                  : aligning
                    ? 'Matching the narration to the script. This takes a minute or so and only happens once.'
                    : alignError ? 'Alignment did not complete, so this video cannot be clipped yet.' : 'This video was narrated before word timings were recorded, so it needs matching up before it can be clipped.'}
              </p>
              {wordCount > 0 ? (
                <button
                  onClick={handleFind}
                  disabled={finding || !project}
                  className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50"
                >
                  {finding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {finding ? 'Reading the transcript…' : 'Find clips'}
                </button>
              ) : (
                <button
                  onClick={handleAlign}
                  disabled={aligning || !project?.voiceover_url}
                  className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50"
                >
                  {aligning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                  {aligning ? 'Preparing…' : alignError ? 'Try again' : 'Prepare for clipping'}
                </button>
              )}
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-error-500/10 border border-error-500/30">
                <AlertCircle className="w-4 h-4 text-error-400 shrink-0 mt-0.5" />
                <p className="text-xs text-error-400">{error}</p>
              </div>
            )}

            {alignError && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-error-500/10 border border-error-500/30">
                <AlertCircle className="w-4 h-4 text-error-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-xs text-error-400">{alignError}</p>
                  {/* By far the most common cause, and not something the message itself
                      explains how to resolve. */}
                  {alignError.includes('forced_alignment') && (
                    <p className="text-xs text-slate-400 mt-1.5">
                      Your ElevenLabs key does not have the Forced Alignment permission. Open{' '}
                      <span className="text-slate-300">elevenlabs.io → Profile → API Keys</span>, edit
                      the key, tick <span className="text-slate-300">Forced Alignment</span>, save, and
                      try again. Nothing needs changing in this app.
                    </p>
                  )}
                </div>
              </div>
            )}

            {notes.length > 0 && (
              <div className="p-3 rounded-lg bg-ink-800 border border-ink-700">
                <p className="text-xs font-medium text-slate-300 mb-1">
                  Some suggestions were dropped because they could not be located in the transcript:
                </p>
                <ul className="text-xs text-ink-500 space-y-0.5">
                  {notes.map((note) => <li key={note}>· {note}</li>)}
                </ul>
              </div>
            )}
          </div>

          {videoClips.length === 0 ? (
            <div className="text-center py-12">
              <Film className="w-10 h-10 text-ink-600 mx-auto mb-3" />
              <p className="text-sm text-slate-400 mb-1">No clips for this video yet</p>
              <p className="text-xs text-ink-500">Find clips reads the narration and proposes the moments worth cutting.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {videoClips.map((clip) => (
                <ClipCard
                  key={clip.id}
                  clip={clip}
                  busy={busyClipId === clip.id}
                  onPatch={patchClip}
                  onRender={handleRender}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Header() {
  return (
    <div>
      <h2 className="text-2xl font-bold text-white">Clips</h2>
      <p className="text-sm text-slate-400 mt-1">
        Cut finished videos into captioned vertical shorts
      </p>
    </div>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ id: string; label: string; description: string }>;
  onChange: (value: string) => void;
}) {
  const active = options.find((o) => o.id === value);
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500"
      >
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      {active && <p className="text-xs text-ink-500 mt-1.5">{active.description}</p>}
    </div>
  );
}

function ClipCard({
  clip,
  busy,
  onPatch,
  onRender,
  onDelete,
}: {
  clip: Clip;
  busy: boolean;
  onPatch: (clip: Clip, patch: Partial<Clip>) => Promise<void>;
  onRender: (clip: Clip) => Promise<void>;
  onDelete: (clip: Clip) => Promise<void>;
}) {
  const [start, setStart] = useState(timecode(clip.start_seconds));
  const [end, setEnd] = useState(timecode(clip.end_seconds));
  const [timeError, setTimeError] = useState('');

  // A render rewrites the row, so the inputs follow the stored values when they change
  // underneath — otherwise an edit made before rendering appears to be lost.
  useEffect(() => { setStart(timecode(clip.start_seconds)); }, [clip.start_seconds]);
  useEffect(() => { setEnd(timecode(clip.end_seconds)); }, [clip.end_seconds]);

  const locked = clip.status === 'queued' || clip.status === 'rendering';
  const duration = clip.end_seconds - clip.start_seconds;

  const commitTimes = async () => {
    const s = parseTimecode(start);
    const e = parseTimecode(end);
    if (s === null || e === null) {
      setTimeError('Use m:ss or a number of seconds.');
      return;
    }
    if (e - s < 3) {
      setTimeError('A clip needs at least 3 seconds.');
      return;
    }
    setTimeError('');
    if (s !== clip.start_seconds || e !== clip.end_seconds) {
      await onPatch(clip, { start_seconds: s, end_seconds: e });
    }
  };

  return (
    <div className="bg-ink-850 border border-ink-700 rounded-xl overflow-hidden">
      <div className="flex flex-col md:flex-row">
        {/* Preview */}
        <div className="md:w-56 shrink-0 bg-ink-900 flex items-center justify-center p-4">
          {clip.output_url ? (
            <video
              src={clip.output_url}
              poster={clip.thumbnail_url || undefined}
              controls
              className="w-full max-w-[180px] rounded-lg"
            />
          ) : (
            <div className="w-full max-w-[180px] aspect-[9/16] rounded-lg border border-dashed border-ink-700 flex flex-col items-center justify-center gap-2">
              {locked ? (
                <>
                  <Loader2 className="w-5 h-5 text-brand-400 animate-spin" />
                  <p className="text-xs text-ink-500 text-center px-2">
                    {CLIP_STAGE_LABELS[clip.stage] ?? 'Queued…'}
                  </p>
                </>
              ) : (
                <>
                  <Scissors className="w-5 h-5 text-ink-600" />
                  <p className="text-xs text-ink-500">Not cut yet</p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Detail */}
        <div className="flex-1 min-w-0 p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <input
              value={clip.title}
              onChange={(e) => onPatch(clip, { title: e.target.value })}
              className="flex-1 min-w-0 bg-transparent text-sm font-semibold text-white focus:outline-none focus:bg-ink-800 rounded px-2 py-1 -mx-2"
            />
            <span
              className={`shrink-0 px-2 py-0.5 rounded-md text-xs font-medium ${
                clip.score >= 75
                  ? 'bg-success-500/15 text-success-400'
                  : clip.score >= 50
                    ? 'bg-brand-500/15 text-brand-400'
                    : 'bg-ink-800 text-ink-500'
              }`}
            >
              {clip.score}
            </span>
          </div>

          {clip.reason && <p className="text-xs text-slate-400">{clip.reason}</p>}

          {clip.transcript && (
            <p className="text-xs text-ink-500 line-clamp-2 leading-relaxed">“{clip.transcript}”</p>
          )}

          {/* Timing */}
          <div className="flex flex-wrap items-center gap-2">
            <TimeInput label="From" value={start} onChange={setStart} onCommit={commitTimes} disabled={locked} />
            <TimeInput label="To" value={end} onChange={setEnd} onCommit={commitTimes} disabled={locked} />
            <span className="text-xs text-ink-500">
              {duration > 0 ? `${Math.round(duration)}s` : '—'}
            </span>
            {duration > 180 && (
              <span className="text-xs text-warning-400">Over 3 minutes — too long for a Short</span>
            )}
          </div>
          {timeError && <p className="text-xs text-error-400">{timeError}</p>}

          {/* Per-clip styling */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={clip.caption_style}
              onChange={(e) => onPatch(clip, { caption_style: e.target.value as CaptionStyle })}
              disabled={locked}
              className="bg-ink-800 border border-ink-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-brand-500 disabled:opacity-50"
            >
              {CAPTION_STYLE_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label} captions</option>
              ))}
            </select>
            <select
              value={clip.reframe}
              onChange={(e) => onPatch(clip, { reframe: e.target.value as Reframe })}
              disabled={locked}
              className="bg-ink-800 border border-ink-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-brand-500 disabled:opacity-50"
            >
              {REFRAME_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={clip.publish_to_youtube}
                onChange={(e) => onPatch(clip, { publish_to_youtube: e.target.checked })}
                disabled={locked}
                className="rounded border-ink-600 bg-ink-800 text-brand-500 focus:ring-0"
              />
              Publish as a Short
            </label>
          </div>

          {clip.status === 'error' && clip.error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-error-500/10 border border-error-500/30">
              <AlertCircle className="w-4 h-4 text-error-400 shrink-0 mt-0.5" />
              <p className="text-xs text-error-400">{clip.error}</p>
            </div>
          )}

          {clip.publish_error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-warning-500/10 border border-warning-500/30">
              <AlertCircle className="w-4 h-4 text-warning-400 shrink-0 mt-0.5" />
              <p className="text-xs text-warning-400">{clip.publish_error}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              onClick={() => onRender(clip)}
              disabled={locked || busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50"
            >
              {locked ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Scissors className="w-3.5 h-3.5" />}
              {locked ? 'Cutting…' : clip.output_url ? 'Re-cut' : 'Cut clip'}
            </button>

            {clip.output_url && (
              <a
                href={downloadUrl(clip.output_url, clip.title || 'clip')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 bg-ink-800 hover:bg-ink-700 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </a>
            )}

            {clip.youtube_video_id && (
              <a
                href={`https://youtu.be/${clip.youtube_video_id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 bg-ink-800 hover:bg-ink-700 transition-colors"
              >
                <Youtube className="w-3.5 h-3.5" />
                On YouTube
                <ExternalLink className="w-3 h-3" />
              </a>
            )}

            {clip.status === 'ready' && (
              <span className="inline-flex items-center gap-1 text-xs text-success-400">
                <Check className="w-3.5 h-3.5" />
                Ready
              </span>
            )}

            <button
              onClick={() => onDelete(clip)}
              disabled={locked || busy}
              className="ml-auto inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs text-ink-500 hover:text-error-400 transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TimeInput({
  label,
  value,
  onChange,
  onCommit,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-500">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        disabled={disabled}
        className="w-16 bg-ink-800 border border-ink-700 rounded-lg px-2 py-1.5 text-xs text-white text-center focus:outline-none focus:border-brand-500 disabled:opacity-50"
      />
    </label>
  );
}
