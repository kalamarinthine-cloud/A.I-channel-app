import {
  listVoices,
  uploadToYouTube,
  supabase,
  type ElevenVoice,
  type Runtime,
  type ScriptProject,
  RUNTIME_OPTIONS,
} from '@/lib/supabase';
import { NICHES, type Niche } from '@/lib/constants';
import { produceVideo, loadProject, type PipelineState, type PipelineStep } from '@/lib/pipeline';
import {
  Wand2, Check, Loader2, AlertCircle, Clock, Download, ExternalLink, Copy,
  Youtube, Image as ImageIcon, Tag, Sparkles, RotateCcw,
} from 'lucide-react';
import { useEffect, useState } from 'react';

interface ProduceProps {
  onRefresh: () => void;
}

export default function Produce({ onRefresh }: ProduceProps) {
  const [title, setTitle] = useState('');
  const [niche, setNiche] = useState<Niche>('Tech/AI');
  const [runtime, setRuntime] = useState<Runtime>('Medium (2-8 min)');
  const [tone, setTone] = useState('informative and engaging');
  const [instructions, setInstructions] = useState('');
  const [voices, setVoices] = useState<ElevenVoice[]>([]);
  const [voiceId, setVoiceId] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [publishToYouTube, setPublishToYouTube] = useState(false);
  const [privacyStatus, setPrivacyStatus] = useState<'private' | 'unlisted' | 'public'>('private');

  const [state, setState] = useState<PipelineState | null>(null);
  const [running, setRunning] = useState(false);
  const [project, setProject] = useState<ScriptProject | null>(null);

  // Load voices once so the run doesn't have to stop and pick one mid-pipeline.
  useEffect(() => {
    (async () => {
      const { voices: v } = await listVoices();
      if (v && v.length > 0) {
        setVoices(v);
        setVoiceId(v[0].voiceId);
      }
    })();
  }, []);

  const handleProduce = async () => {
    if (!title.trim() || running) return;
    setRunning(true);
    setProject(null);
    setState(null);

    const finalState = await produceVideo(
      {
        title: title.trim(),
        niche,
        runtime,
        tone: tone.trim(),
        instructions: instructions.trim(),
        voiceId: voiceId || undefined,
        publishToYouTube,
        privacyStatus,
      },
      setState,
    );

    setRunning(false);
    onRefresh();

    if (finalState.projectId) {
      setProject(await loadProject(finalState.projectId));
    }
  };

  const handleReset = () => {
    setState(null);
    setProject(null);
    setTitle('');
    setInstructions('');
  };

  const canProduce = title.trim().length > 0 && !running;

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-bold text-white">Produce</h2>
        <p className="text-sm text-slate-400 mt-1">
          One idea in, a finished video out — script, voiceover, B-roll, edit, and thumbnail
        </p>
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* Brief */}
        <div className="col-span-12 lg:col-span-5 space-y-4">
          <div className="bg-ink-850 border border-ink-700 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold text-white">The brief</h3>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
                Video idea
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={running}
                placeholder="e.g. How AI Will Replace 40% of Office Jobs"
                className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-brand-500 transition-colors disabled:opacity-50"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Niche</label>
                <select
                  value={niche}
                  onChange={(e) => setNiche(e.target.value as Niche)}
                  disabled={running}
                  className="w-full px-3 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors disabled:opacity-50"
                >
                  {NICHES.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Length</label>
                <select
                  value={runtime}
                  onChange={(e) => setRuntime(e.target.value as Runtime)}
                  disabled={running}
                  className="w-full px-3 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors disabled:opacity-50"
                >
                  {RUNTIME_OPTIONS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
            </div>

            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-xs text-brand-400 hover:text-brand-300 font-medium"
            >
              {showAdvanced ? 'Hide' : 'Show'} tone, voice & extra direction
            </button>

            {showAdvanced && (
              <div className="space-y-4 pt-1">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Tone</label>
                  <input
                    type="text"
                    value={tone}
                    onChange={(e) => setTone(e.target.value)}
                    disabled={running}
                    className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-brand-500 transition-colors disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Voice</label>
                  <select
                    value={voiceId}
                    onChange={(e) => setVoiceId(e.target.value)}
                    disabled={running || voices.length === 0}
                    className="w-full px-3 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors disabled:opacity-50"
                  >
                    {voices.length === 0 && <option value="">Loading voices…</option>}
                    {voices.map((v) => (
                      <option key={v.voiceId} value={v.voiceId}>
                        {v.name}{v.category ? ` (${v.category})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
                    Extra direction (optional)
                  </label>
                  <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    disabled={running}
                    rows={3}
                    placeholder="e.g. Focus on blue-collar impact. Mention specific companies."
                    className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-brand-500 transition-colors resize-none disabled:opacity-50"
                  />
                </div>
              </div>
            )}

            <div className="pt-1 space-y-3 border-t border-ink-700">
              <label className="flex items-start gap-2.5 cursor-pointer pt-3">
                <input
                  type="checkbox"
                  checked={publishToYouTube}
                  onChange={(e) => setPublishToYouTube(e.target.checked)}
                  disabled={running}
                  className="mt-0.5 w-4 h-4 rounded accent-brand-500 shrink-0"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-white">
                    <Youtube className="w-3.5 h-3.5 text-error-400" />
                    Publish to YouTube when finished
                  </span>
                  <span className="block text-xs text-ink-500 mt-0.5 leading-relaxed">
                    Off by default — each upload uses about a sixth of your daily YouTube quota.
                  </span>
                </span>
              </label>

              {publishToYouTube && (
                <div className="flex items-center gap-3 pl-6">
                  <label className="text-xs font-medium text-slate-400 uppercase tracking-wide">Visibility</label>
                  <select
                    value={privacyStatus}
                    onChange={(e) => setPrivacyStatus(e.target.value as typeof privacyStatus)}
                    disabled={running}
                    className="flex-1 px-3 py-2 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white focus:outline-none focus:border-brand-500 disabled:opacity-50"
                  >
                    <option value="private">Private</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public</option>
                  </select>
                </div>
              )}
            </div>

            <button
              onClick={handleProduce}
              disabled={!canProduce}
              className="w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-sm font-semibold transition-all shadow-lg shadow-brand-600/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {running ? 'Producing…' : 'Produce Video'}
            </button>

            {state?.finished && (
              <button
                onClick={handleReset}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-slate-300 text-sm font-medium border border-ink-700 transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
                Start another
              </button>
            )}
          </div>

          {running && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-ink-800 border border-ink-700">
              <Clock className="w-4 h-4 text-ink-500 shrink-0 mt-0.5" />
              <p className="text-xs text-slate-400">
                Rendering happens on the worker, not in this tab. Once the run reaches the render step you can close
                this page — the finished video will be waiting in Projects.
              </p>
            </div>
          )}
        </div>

        {/* Progress + result */}
        <div className="col-span-12 lg:col-span-7 space-y-4">
          {!state ? (
            <div className="bg-ink-850 border border-ink-700 rounded-xl p-12 text-center">
              <Sparkles className="w-10 h-10 text-ink-600 mx-auto mb-3" />
              <p className="text-sm text-slate-400 mb-1">Nothing in production yet</p>
              <p className="text-xs text-ink-500">Describe a video on the left and hit Produce.</p>
            </div>
          ) : (
            <div className="bg-ink-850 border border-ink-700 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Production run</h3>
              <div className="space-y-1">
                {state.steps.map((step) => (
                  <StepRow key={step.id} step={step} />
                ))}
              </div>

              {state.error && (
                <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-error-500/10 border border-error-500/30">
                  <AlertCircle className="w-4 h-4 text-error-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs text-error-400 font-medium">Run stopped</p>
                    <p className="text-xs text-error-400/80 mt-1">{state.error}</p>
                    <p className="text-xs text-error-400/60 mt-1.5">
                      Everything completed before this point was saved — you can finish the video by hand from the
                      Scripts, B-Roll, and Assembly tabs.
                    </p>
                  </div>
                </div>
              )}

              {state.warnings.map((warning, i) => (
                <div key={i} className="mt-3 flex items-start gap-2 p-3 rounded-lg bg-warning-500/10 border border-warning-500/30">
                  <AlertCircle className="w-4 h-4 text-warning-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-warning-400">{warning}</p>
                </div>
              ))}
            </div>
          )}

          {project && <ResultPanel project={project} onChange={setProject} />}
        </div>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: PipelineStep }) {
  const icon =
    step.status === 'done' ? <Check className="w-4 h-4 text-success-400" />
    : step.status === 'running' ? <Loader2 className="w-4 h-4 text-brand-400 animate-spin" />
    : step.status === 'error' ? <AlertCircle className="w-4 h-4 text-error-400" />
    : <Clock className="w-4 h-4 text-ink-500" />;

  const bg =
    step.status === 'done' ? 'bg-success-500/15'
    : step.status === 'running' ? 'bg-brand-600/15'
    : step.status === 'error' ? 'bg-error-500/15'
    : 'bg-ink-800';

  return (
    <div className="flex items-center gap-3 py-2">
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${bg}`}>{icon}</div>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${step.status === 'pending' ? 'text-slate-500' : 'text-white'}`}>
          {step.label}
        </p>
        {step.detail && <p className="text-xs text-ink-500 mt-0.5 truncate">{step.detail}</p>}
        {step.status === 'running' && step.percent > 0 && (
          <div className="h-1.5 rounded-full bg-ink-700 overflow-hidden mt-2">
            <div
              className="h-full bg-brand-500 rounded-full transition-all duration-300"
              style={{ width: `${step.percent}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ResultPanel({ project, onChange }: { project: ScriptProject; onChange: (p: ScriptProject) => void }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [privacy, setPrivacy] = useState<'private' | 'unlisted' | 'public'>('private');
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (label: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const handleUpload = async () => {
    if (!project.compiled_video_url) return;
    setUploading(true);
    setUploadError('');

    await supabase.from('script_projects').update({ youtube_status: 'uploading' }).eq('id', project.id);

    const { youtubeVideoId, error } = await uploadToYouTube({
      projectId: project.id,
      videoUrl: project.compiled_video_url,
      thumbnailUrl: project.thumbnail_url || undefined,
      title: project.youtube_title || 'Untitled',
      description: project.youtube_description,
      tags: project.youtube_tags ?? [],
      privacyStatus: privacy,
    });

    setUploading(false);

    if (error || !youtubeVideoId) {
      setUploadError(error ?? 'Upload did not return a video ID.');
      await supabase.from('script_projects').update({ youtube_status: 'failed' }).eq('id', project.id);
      return;
    }

    await supabase
      .from('script_projects')
      .update({ youtube_status: 'uploaded', youtube_video_id: youtubeVideoId })
      .eq('id', project.id);
    onChange({ ...project, youtube_status: 'uploaded', youtube_video_id: youtubeVideoId });
  };

  return (
    <div className="bg-gradient-to-br from-ink-850 to-ink-900 border border-ink-700 rounded-2xl overflow-hidden animate-fade-in">
      <div className="flex items-center justify-between px-5 py-4 border-b border-ink-700 bg-ink-900/50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-success-500/15 flex items-center justify-center">
            <Check className="w-4 h-4 text-success-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Ready to publish</h3>
            <p className="text-xs text-ink-500">Review, then send it to YouTube</p>
          </div>
        </div>
      </div>

      {project.compiled_video_url && (
        <video src={project.compiled_video_url} controls className="w-full aspect-video bg-black object-contain" />
      )}

      {project.compiled_is_preview && (
        <div className="flex items-start gap-2 px-5 pt-4">
          <AlertCircle className="w-4 h-4 text-warning-400 shrink-0 mt-0.5" />
          <p className="text-xs text-warning-400 leading-relaxed">
            This is a 480p preview. The full-quality video was too large for your storage plan, so it went straight
            to YouTube — download it from there rather than here.
          </p>
        </div>
      )}

      <div className="p-5 space-y-5">
        {project.thumbnail_url && (
          <div>
            <p className="flex items-center gap-1.5 text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">
              <ImageIcon className="w-3.5 h-3.5" /> Thumbnail
            </p>
            <img
              src={project.thumbnail_url}
              alt="Generated thumbnail"
              className="w-full max-w-sm rounded-lg border border-ink-700"
            />
          </div>
        )}

        <MetadataField
          label="Title"
          value={project.youtube_title}
          copied={copied === 'Title'}
          onCopy={() => copy('Title', project.youtube_title)}
        />
        <MetadataField
          label="Description"
          value={project.youtube_description}
          multiline
          copied={copied === 'Description'}
          onCopy={() => copy('Description', project.youtube_description)}
        />

        {project.youtube_tags?.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-slate-400 uppercase tracking-wide">
                <Tag className="w-3.5 h-3.5" /> Tags
              </p>
              <button
                onClick={() => copy('Tags', project.youtube_tags.join(', '))}
                className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300"
              >
                <Copy className="w-3 h-3" />
                {copied === 'Tags' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {project.youtube_tags.map((tag) => (
                <span key={tag} className="px-2 py-1 rounded-md bg-ink-800 border border-ink-700 text-xs text-slate-300">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Publish */}
        <div className="pt-4 border-t border-ink-700 space-y-3">
          {project.youtube_status === 'uploaded' && project.youtube_video_id ? (
            <a
              href={`https://studio.youtube.com/video/${project.youtube_video_id}/edit`}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-success-500/15 border border-success-500/30 text-success-400 text-sm font-semibold transition-colors"
            >
              <Check className="w-4 h-4" />
              Uploaded — open in YouTube Studio
            </a>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide">Visibility</label>
                <select
                  value={privacy}
                  onChange={(e) => setPrivacy(e.target.value as typeof privacy)}
                  className="flex-1 px-3 py-2 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white focus:outline-none focus:border-brand-500"
                >
                  <option value="private">Private</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="public">Public</option>
                </select>
              </div>

              <p className="text-xs text-ink-500 leading-relaxed">
                YouTube forces API uploads to <span className="text-slate-400">private</span> until your Google Cloud
                project passes its compliance audit — Unlisted and Public only take effect after that.
              </p>

              <button
                onClick={handleUpload}
                disabled={uploading || !project.compiled_video_url}
                className="w-full flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-error-500 hover:bg-error-600 text-white text-sm font-semibold transition-colors disabled:opacity-40"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Youtube className="w-4 h-4" />}
                {uploading ? 'Uploading to YouTube…' : 'Upload to YouTube'}
              </button>
            </>
          )}

          {uploadError && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-error-500/10 border border-error-500/30">
              <AlertCircle className="w-4 h-4 text-error-400 shrink-0 mt-0.5" />
              <p className="text-xs text-error-400">{uploadError}</p>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            {project.compiled_video_url && (
              <a
                href={project.compiled_video_url}
                download
                className="flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-ink-800 hover:bg-ink-700 text-slate-300 text-sm font-medium border border-ink-700 transition-colors"
              >
                <Download className="w-4 h-4" />
                Download video
              </a>
            )}
            {project.thumbnail_url && (
              <a
                href={project.thumbnail_url}
                download
                className="flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-ink-800 hover:bg-ink-700 text-slate-300 text-sm font-medium border border-ink-700 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                Download thumbnail
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetadataField({
  label,
  value,
  multiline,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  if (!value) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</p>
        <button onClick={onCopy} className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300">
          <Copy className="w-3 h-3" />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className={`bg-ink-800 border border-ink-700 rounded-lg p-3 ${multiline ? 'max-h-48 overflow-y-auto' : ''}`}>
        <p className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">{value}</p>
      </div>
    </div>
  );
}
