import { supabase, enqueueRender, getRenderJob, type Video, type BrollAsset, type AssetType, type RenderJob, type ScriptProject, ASSET_TYPE_LABELS, ASSET_STATUS_COLORS } from '@/lib/supabase';
import { compileVideo, type CompileProgress } from '@/lib/videoCompiler';
import { Play, Pause, Download, Volume2, Film as FilmIcon, Image, Music, Monitor, ExternalLink, Check, Clock, AlertCircle, Clapperboard, Wand2, Loader2, Video as VideoIcon, Maximize2, RotateCcw, Server, FileVideo } from 'lucide-react';
import { useEffect, useState, useCallback, useRef } from 'react';

const ASSET_TYPE_ICONS: Record<AssetType, typeof FilmIcon> = {
  footage: FilmIcon,
  image: Image,
  screen_recording: Monitor,
  music: Music,
  sfx: Volume2,
};

interface AssemblyProps {
  onRefresh: () => void;
}

export default function Assembly({ onRefresh }: AssemblyProps) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [assets, setAssets] = useState<BrollAsset[]>([]);
  const [projects, setProjects] = useState<ScriptProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [compileProgress, setCompileProgress] = useState<CompileProgress | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [queueJob, setQueueJob] = useState<RenderJob | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: v }, { data: a }, { data: p }] = await Promise.all([
      supabase.from('videos').select('*').order('updated_at', { ascending: false }),
      supabase.from('broll_assets').select('*'),
      supabase.from('script_projects').select('*').order('created_at', { ascending: false }),
    ]);
    setVideos(v ?? []);
    setAssets(a ?? []);
    setProjects(p ?? []);
    if (v && v.length > 0 && !selectedId) {
      setSelectedId(v[0].id);
    }
    setLoading(false);
  }, [selectedId]);

  useEffect(() => { load(); }, [load]);

  const selected = videos.find((v) => v.id === selectedId) ?? null;
  const videoAssets = assets.filter((a) => a.video_id === selectedId);
  const videoProjects = projects.filter((p) => p.video_id === selectedId);

  const readyAssets = videoAssets.filter((a) => a.status === 'ready');
  const sourcedAssets = videoAssets.filter((a) => a.status === 'sourced');
  const neededAssets = videoAssets.filter((a) => a.status === 'needed');

  const hasVoiceover = !!(selected?.voiceover_url && selected.voiceover_url.length > 0);
  const hasScript = !!(selected?.script_content && selected.script_content.trim().length > 0);

  // Latest project that has both script and voiceover — this is what we compile into
  const latestProject = videoProjects[0] ?? null;
  const hasCompiledVideo = !!(latestProject?.compiled_video_url && latestProject.compiled_video_url.length > 0);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const handleStatusChange = async (asset: BrollAsset, status: typeof asset.status) => {
    await supabase.from('broll_assets').update({ status }).eq('id', asset.id);
    await load();
    onRefresh();
  };

  const assemblyReady = hasVoiceover && readyAssets.length > 0;

  // A finished run leaves compileProgress on 'done', so treat that as idle too —
  // otherwise the button never comes back and a bad cut can't be re-rendered.
  const compileIdle = !compileProgress || compileProgress.phase === 'done';

  const handleCompile = async () => {
    if (!selected || !hasVoiceover || !latestProject) return;
    setCompileProgress({ phase: 'preparing', message: 'Starting…', percent: 0 });

    const { result, error } = await compileVideo(
      selected.voiceover_url!,
      readyAssets,
      selected.id,
      latestProject.id,
      setCompileProgress,
    );

    if (error) {
      setCompileProgress({ phase: 'error', message: error, percent: 0 });
      return;
    }

    if (result) {
      // Save compiled video URL to the project
      await supabase
        .from('script_projects')
        .update({ compiled_video_url: result.url })
        .eq('id', latestProject.id);
      await load();
      onRefresh();
      // Scroll to top so the finished video panel is visible
      setTimeout(() => {
        const panel = document.getElementById('finished-video-panel');
        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  };

  /**
   * Hands the render to the worker instead of doing it here. Polling stops as soon as the
   * job reaches a terminal state — and because the job lives in the database, navigating
   * away mid-render loses nothing.
   */
  const handleQueue = async () => {
    if (!selected || !latestProject || queueing) return;
    setQueueing(true);

    const { job, error } = await enqueueRender({ videoId: selected.id, projectId: latestProject.id });
    if (error || !job) {
      setQueueJob({ status: 'error', error: error ?? 'Could not queue the render.' } as RenderJob);
      setQueueing(false);
      return;
    }

    setQueueJob(job);

    for (;;) {
      await new Promise((r) => setTimeout(r, 2500));
      const current = await getRenderJob(job.id);
      if (!current) continue;
      setQueueJob(current);

      if (current.status === 'done') {
        await load();
        onRefresh();
        setQueueJob(null);
        break;
      }
      if (current.status === 'error') break;
    }

    setQueueing(false);
  };

  if (loading) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div>
          <h2 className="text-2xl font-bold text-white">Assembly</h2>
          <p className="text-sm text-slate-400 mt-1">Combine your voiceover and B-roll into a finished video</p>
        </div>
        <p className="text-sm text-slate-400 py-8 text-center">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-bold text-white">Assembly</h2>
        <p className="text-sm text-slate-400 mt-1">Combine your voiceover and B-roll into a finished video</p>
      </div>

      {videos.length === 0 ? (
        <div className="text-center py-16">
          <Clapperboard className="w-12 h-12 text-ink-600 mx-auto mb-4" />
          <p className="text-sm text-slate-400">No videos yet. Create one in the Videos tab first.</p>
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {/* Video list */}
          <div className="col-span-4 lg:col-span-3 space-y-2">
            {videos.map((video) => {
              const vAssets = assets.filter((a) => a.video_id === video.id);
              const vReady = vAssets.filter((a) => a.status === 'ready').length;
              const vHasVoice = !!(video.voiceover_url && video.voiceover_url.length > 0);
              const vProjects = projects.filter((p) => p.video_id === video.id);
              const vHasCompiled = vProjects.some((p) => p.compiled_video_url && p.compiled_video_url.length > 0);
              const isSelected = video.id === selectedId;
              return (
                <button
                  key={video.id}
                  onClick={() => setSelectedId(video.id)}
                  className={`w-full text-left p-4 rounded-xl border transition-all ${
                    isSelected
                      ? 'bg-ink-800 border-brand-500 shadow-md shadow-brand-600/10'
                      : 'bg-ink-850 border-ink-700 hover:border-ink-600'
                  }`}
                >
                  <p className="text-sm font-medium text-white truncate">{video.title}</p>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {vHasVoice && (
                      <span className="flex items-center gap-1 text-xs text-brand-400">
                        <Volume2 className="w-3 h-3" />Voice
                      </span>
                    )}
                    {vHasCompiled && (
                      <span className="flex items-center gap-1 text-xs text-success-400">
                        <VideoIcon className="w-3 h-3" />Compiled
                      </span>
                    )}
                    <span className="text-xs text-ink-500">{vReady}/{vAssets.length} ready</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Assembly panel */}
          <div className="col-span-8 lg:col-span-9 space-y-4">
            {selected ? (
              <>
                {/* Readiness checklist */}
                <div className="bg-ink-850 border border-ink-700 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-white mb-4">Production Checklist</h3>
                  <div className="space-y-3">
                    <ChecklistItem
                      done={hasScript}
                      label="Script written"
                      hint={hasScript ? `${selected.script_content.trim().split(/\s+/).length} words` : 'Go to Scripts tab to write or generate one'}
                    />
                    <ChecklistItem
                      done={hasVoiceover}
                      label="Voiceover generated"
                      hint={hasVoiceover ? `Voice: ${selected.voiceover_voice || 'Unknown'}` : 'Go to Scripts tab to generate a voiceover'}
                    />
                    <ChecklistItem
                      done={readyAssets.length > 0}
                      label="B-roll assets ready"
                      hint={readyAssets.length > 0 ? `${readyAssets.length} asset${readyAssets.length === 1 ? '' : 's'} ready` : 'Mark assets as "ready" in B-Roll tab'}
                    />
                  </div>
                  {assemblyReady && compileIdle && (
                    <div className="mt-4 space-y-3">
                      {!hasCompiledVideo && (
                        <div className="p-3 rounded-lg bg-success-500/10 border border-success-500/30 flex items-center gap-2">
                          <Check className="w-4 h-4 text-success-400" />
                          <p className="text-xs text-success-400 font-medium">All components ready — auto-edit your video now!</p>
                        </div>
                      )}
                      <button
                        onClick={handleCompile}
                        className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                          hasCompiledVideo
                            ? 'bg-ink-800 hover:bg-ink-700 text-slate-300 border border-ink-700'
                            : 'bg-brand-600 hover:bg-brand-500 text-white shadow-md shadow-brand-600/20'
                        }`}
                      >
                        {hasCompiledVideo ? <RotateCcw className="w-4 h-4" /> : <Wand2 className="w-4 h-4" />}
                        {hasCompiledVideo ? 'Re-compile Video' : 'Auto-Edit Video'}
                      </button>
                      <button
                        onClick={handleQueue}
                        disabled={queueing}
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-ink-800 hover:bg-ink-700 text-slate-300 text-sm font-medium border border-ink-700 transition-colors disabled:opacity-50"
                      >
                        {queueing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Server className="w-4 h-4" />}
                        {queueing ? 'Queued…' : 'Render on worker'}
                      </button>

                      <p className="text-xs text-ink-500 leading-relaxed">
                        Rendering in the browser needs this tab open for the video's full length. The worker renders
                        faster than real time and doesn't need the page at all — it just has to be running.
                      </p>

                      {queueJob && (
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-ink-800 border border-ink-700">
                          {queueJob.status === 'error'
                            ? <AlertCircle className="w-4 h-4 text-error-400 shrink-0 mt-0.5" />
                            : <Loader2 className="w-4 h-4 text-brand-400 shrink-0 mt-0.5 animate-spin" />}
                          <p className={`text-xs ${queueJob.status === 'error' ? 'text-error-400' : 'text-slate-400'}`}>
                            {queueJob.status === 'error'
                              ? queueJob.error
                              : queueJob.status === 'queued'
                                ? 'Waiting for a worker to pick this up…'
                                : `Worker: ${queueJob.stage || 'rendering'}…`}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Compile progress */}
                {compileProgress && compileProgress.phase !== 'done' && compileProgress.phase !== 'error' && (
                  <div className="bg-ink-850 border border-ink-700 rounded-xl p-5">
                    <div className="flex items-center gap-3 mb-3">
                      <Loader2 className="w-5 h-5 text-brand-400 animate-spin" />
                      <p className="text-sm text-white font-medium">{compileProgress.message}</p>
                    </div>
                    <div className="h-2 rounded-full bg-ink-700 overflow-hidden">
                      <div
                        className="h-full bg-brand-500 rounded-full transition-all duration-300"
                        style={{ width: `${compileProgress.percent}%` }}
                      />
                    </div>
                    <p className="text-xs text-ink-500 mt-2">{compileProgress.percent}%</p>
                  </div>
                )}

                {/* Compile error */}
                {compileProgress && compileProgress.phase === 'error' && (
                  <div className="bg-error-500/10 border border-error-500/30 rounded-xl p-4 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-error-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm text-error-400 font-medium">Compilation failed</p>
                      <p className="text-xs text-error-400/80 mt-1">{compileProgress.message}</p>
                      <button
                        onClick={() => setCompileProgress(null)}
                        className="mt-2 text-xs text-brand-400 hover:text-brand-300 font-medium"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}

                {/* Compiled video — Vid.ai-inspired export panel */}
                {hasCompiledVideo && latestProject?.compiled_video_url && (
                  <div id="finished-video-panel" className="bg-gradient-to-br from-ink-850 to-ink-900 border border-ink-700 rounded-2xl overflow-hidden animate-fade-in">
                    {/* Header bar */}
                    <div className="flex items-center justify-between px-5 py-4 border-b border-ink-700 bg-ink-900/50">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-success-500/15 flex items-center justify-center">
                          <VideoIcon className="w-4 h-4 text-success-400" />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-white">Finished Video</h3>
                          <p className="text-xs text-ink-500">Auto-edited and ready to export</p>
                        </div>
                      </div>
                      <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-success-500/10 border border-success-500/30 text-xs text-success-400 font-medium">
                        <Check className="w-3 h-3" />
                        Compiled
                      </span>
                    </div>

                    {/* Large video preview */}
                    <div className="relative group bg-black">
                      <video
                        ref={videoRef}
                        src={latestProject.compiled_video_url}
                        controls
                        className="w-full aspect-video object-contain"
                      />
                    </div>

                    {/* Metadata + export controls */}
                    <div className="p-5 space-y-4">
                      {/* Metadata grid */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="bg-ink-800 rounded-lg p-3 border border-ink-700">
                          <div className="flex items-center gap-1.5 text-xs text-ink-500 mb-1">
                            <FileVideo className="w-3 h-3" />
                            Format
                          </div>
                          <p className="text-sm font-medium text-white">WebM</p>
                        </div>
                        <div className="bg-ink-800 rounded-lg p-3 border border-ink-700">
                          <div className="flex items-center gap-1.5 text-xs text-ink-500 mb-1">
                            <Maximize2 className="w-3 h-3" />
                            Resolution
                          </div>
                          <p className="text-sm font-medium text-white">1080p</p>
                        </div>
                        <div className="bg-ink-800 rounded-lg p-3 border border-ink-700">
                          <div className="flex items-center gap-1.5 text-xs text-ink-500 mb-1">
                            <Volume2 className="w-3 h-3" />
                            Audio
                          </div>
                          <p className="text-sm font-medium text-white">{selected.voiceover_voice || 'TTS Voice'}</p>
                        </div>
                        <div className="bg-ink-800 rounded-lg p-3 border border-ink-700">
                          <div className="flex items-center gap-1.5 text-xs text-ink-500 mb-1">
                            <Clapperboard className="w-3 h-3" />
                            Assets
                          </div>
                          <p className="text-sm font-medium text-white">{readyAssets.length} clips</p>
                        </div>
                      </div>

                      {/* Export buttons */}
                      <div className="flex flex-col sm:flex-row gap-3">
                        <a
                          href={latestProject.compiled_video_url}
                          download={`compiled-${selected.title.replace(/\s+/g, '-')}.webm`}
                          className="flex-1 flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-sm font-semibold transition-all shadow-lg shadow-brand-600/20 hover:shadow-brand-600/30"
                        >
                          <Download className="w-4 h-4" />
                          Export to Computer
                        </a>
                        <a
                          href={latestProject.compiled_video_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-ink-800 hover:bg-ink-700 text-slate-300 text-sm font-medium border border-ink-700 transition-colors"
                        >
                          <ExternalLink className="w-4 h-4" />
                          Open in New Tab
                        </a>
                      </div>

                      {/* Success badge after compile */}
                      {compileProgress?.phase === 'done' && (
                        <div className="p-3 rounded-lg bg-success-500/10 border border-success-500/30 flex items-center gap-2">
                          <Check className="w-4 h-4 text-success-400" />
                          <p className="text-xs text-success-400 font-medium">Video compiled and saved to project! Export it anytime.</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Voiceover player */}
                <div className="bg-ink-850 border border-ink-700 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-white">Voiceover</h3>
                    {hasVoiceover && (
                      <span className="text-xs text-ink-500">{selected.voiceover_voice || 'Unknown voice'}</span>
                    )}
                  </div>
                  {hasVoiceover ? (
                    <div className="flex items-center gap-3">
                      <button
                        onClick={togglePlay}
                        className="w-10 h-10 rounded-full bg-brand-600 hover:bg-brand-500 flex items-center justify-center text-white transition-colors shrink-0"
                      >
                        {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="h-2 rounded-full bg-ink-700 overflow-hidden">
                          <div className="h-full bg-brand-500 rounded-full transition-all" style={{ width: isPlaying ? '100%' : '0%' }} />
                        </div>
                        <p className="text-xs text-ink-500 mt-1.5">Voiceover audio</p>
                      </div>
                      <audio
                        ref={audioRef}
                        src={selected.voiceover_url}
                        onEnded={() => setIsPlaying(false)}
                        className="hidden"
                      />
                      <a
                        href={selected.voiceover_url}
                        download={`voiceover-${selected.title.replace(/\s+/g, '-')}.mp3`}
                        className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-ink-700 transition-colors shrink-0"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 py-3 px-4 rounded-lg bg-ink-800 border border-ink-700">
                      <AlertCircle className="w-4 h-4 text-ink-500 shrink-0" />
                      <p className="text-xs text-ink-500">No voiceover yet. Generate one from the Scripts tab.</p>
                    </div>
                  )}
                </div>

                {/* B-roll assets */}
                <div className="bg-ink-850 border border-ink-700 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-white">B-Roll Assets</h3>
                    <span className="text-xs text-ink-500">{videoAssets.length} total</span>
                  </div>
                  {videoAssets.length === 0 ? (
                    <div className="text-center py-6">
                      <Clapperboard className="w-8 h-8 text-ink-600 mx-auto mb-2" />
                      <p className="text-xs text-ink-500">No assets tracked. Add some in the B-Roll tab.</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {readyAssets.length > 0 && (
                        <AssetSection title="Ready" icon={Check} iconColor="text-success-400" assets={readyAssets} onStatusChange={handleStatusChange} />
                      )}
                      {sourcedAssets.length > 0 && (
                        <AssetSection title="Sourced" icon={Clock} iconColor="text-warning-400" assets={sourcedAssets} onStatusChange={handleStatusChange} />
                      )}
                      {neededAssets.length > 0 && (
                        <AssetSection title="Still Needed" icon={AlertCircle} iconColor="text-error-400" assets={neededAssets} onStatusChange={handleStatusChange} />
                      )}
                    </div>
                  )}
                </div>

                {/* Script preview */}
                {hasScript && (
                  <div className="bg-ink-850 border border-ink-700 rounded-xl p-5">
                    <h3 className="text-sm font-semibold text-white mb-3">Script</h3>
                    <div className="max-h-48 overflow-y-auto pr-2">
                      <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">{selected.script_content}</p>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-slate-400">Select a video to view its assembly</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ChecklistItem({ done, label, hint }: { done: boolean; label: string; hint: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${done ? 'bg-success-500/15' : 'bg-ink-800'}`}>
        {done ? <Check className="w-4 h-4 text-success-400" /> : <Clock className="w-4 h-4 text-ink-500" />}
      </div>
      <div className="min-w-0">
        <p className={`text-sm font-medium ${done ? 'text-white' : 'text-slate-400'}`}>{label}</p>
        <p className="text-xs text-ink-500 mt-0.5">{hint}</p>
      </div>
    </div>
  );
}

function AssetSection({
  title,
  icon: Icon,
  iconColor,
  assets,
  onStatusChange,
}: {
  title: string;
  icon: typeof Check;
  iconColor: string;
  assets: BrollAsset[];
  onStatusChange: (asset: BrollAsset, status: BrollAsset['status']) => Promise<void>;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-3.5 h-3.5 ${iconColor}`} />
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{title} ({assets.length})</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {assets.map((asset) => {
          const TypeIcon = ASSET_TYPE_ICONS[asset.type];
          return (
            <div key={asset.id} className="bg-ink-800 border border-ink-700 rounded-lg p-3">
              <div className="flex items-start gap-2 mb-2">
                <div className="w-7 h-7 rounded-lg bg-ink-700 flex items-center justify-center shrink-0">
                  <TypeIcon className="w-3.5 h-3.5 text-brand-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white truncate">{asset.label}</p>
                  <p className="text-xs text-ink-500">{ASSET_TYPE_LABELS[asset.type]}</p>
                </div>
                {asset.source_url && (
                  <a
                    href={asset.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1 rounded text-slate-400 hover:text-brand-400 transition-colors shrink-0"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
              <div className="flex items-center gap-1">
                {(['needed', 'sourced', 'ready'] as BrollAsset['status'][]).map((s) => (
                  <button
                    key={s}
                    onClick={() => onStatusChange(asset, s)}
                    className={`flex-1 py-1 rounded-md text-xs font-medium capitalize transition-all ${
                      asset.status === s
                        ? `${ASSET_STATUS_COLORS[s]} shadow-sm`
                        : 'bg-ink-900 text-ink-500 hover:bg-ink-700'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
