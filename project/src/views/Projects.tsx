import { downloadUrl, supabase, type Video, type ScriptProject } from '@/lib/supabase';
import { FileText, Volume2, Play, Pause, Download, Clock, ChevronDown, ChevronRight, Film, Video as VideoIcon } from 'lucide-react';
import { useEffect, useState, useCallback, useRef } from 'react';

interface ProjectsProps {
  onRefresh: () => void;
}

export default function Projects({ onRefresh }: ProjectsProps) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [projects, setProjects] = useState<ScriptProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedVideoId, setExpandedVideoId] = useState<string | null>(null);
  const [playingProjectId, setPlayingProjectId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: v }, { data: p }] = await Promise.all([
      supabase.from('videos').select('*').order('updated_at', { ascending: false }),
      supabase.from('script_projects').select('*').order('created_at', { ascending: false }),
    ]);
    setVideos(v ?? []);
    setProjects(p ?? []);
    if (v && v.length > 0 && !expandedVideoId) {
      setExpandedVideoId(v[0].id);
    }
    setLoading(false);
  }, [expandedVideoId]);

  useEffect(() => { load(); }, [load]);

  const projectsByVideo = (videoId: string) => projects.filter((p) => p.video_id === videoId);

  const togglePlay = (project: ScriptProject) => {
    if (!project.voiceover_url) return;
    if (playingProjectId === project.id) {
      audioRef.current?.pause();
      setPlayingProjectId(null);
    } else {
      if (audioRef.current) {
        audioRef.current.src = project.voiceover_url;
        audioRef.current.play();
        setPlayingProjectId(project.id);
      }
    }
  };

  const handleDeleteProject = async (id: string) => {
    await supabase.from('script_projects').delete().eq('id', id);
    await load();
    onRefresh();
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };

  const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

  if (loading) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div>
          <h2 className="text-2xl font-bold text-white">Projects</h2>
          <p className="text-sm text-slate-400 mt-1">Every script and voiceover generation, grouped by video</p>
        </div>
        <p className="text-sm text-slate-400 py-8 text-center">Loading…</p>
      </div>
    );
  }

  const videosWithProjects = videos.filter((v) => projectsByVideo(v.id).length > 0);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-bold text-white">Projects</h2>
        <p className="text-sm text-slate-400 mt-1">Every script and voiceover generation, grouped by video</p>
      </div>

      {videosWithProjects.length === 0 ? (
        <div className="text-center py-16">
          <FileText className="w-12 h-12 text-ink-600 mx-auto mb-4" />
          <p className="text-sm text-slate-400 mb-1">No projects yet</p>
          <p className="text-xs text-ink-500">Generate a script from the Scripts tab to create your first project</p>
        </div>
      ) : (
        <div className="space-y-3">
          {videosWithProjects.map((video) => {
            const vProjects = projectsByVideo(video.id);
            const isExpanded = expandedVideoId === video.id;
            return (
              <div key={video.id} className="bg-ink-850 border border-ink-700 rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpandedVideoId(isExpanded ? null : video.id)}
                  className="w-full flex items-center justify-between p-5 hover:bg-ink-800 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {isExpanded ? <ChevronDown className="w-4 h-4 text-ink-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-ink-500 shrink-0" />}
                    <Film className="w-4 h-4 text-brand-400 shrink-0" />
                    <div className="min-w-0 text-left">
                      <p className="text-sm font-semibold text-white truncate">{video.title}</p>
                      <p className="text-xs text-ink-500 mt-0.5">{vProjects.length} generation{vProjects.length === 1 ? '' : 's'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="flex items-center gap-3 shrink-0">
                      {vProjects.filter((p) => p.voiceover_url).length > 0 && (
                        <span className="flex items-center gap-1 text-xs text-brand-400">
                          <Volume2 className="w-3 h-3" />
                          {vProjects.filter((p) => p.voiceover_url).length} voiceover{vProjects.filter((p) => p.voiceover_url).length === 1 ? '' : 's'}
                        </span>
                      )}
                      {vProjects.filter((p) => p.compiled_video_url).length > 0 && (
                        <span className="flex items-center gap-1 text-xs text-success-400">
                          <VideoIcon className="w-3 h-3" />
                          {vProjects.filter((p) => p.compiled_video_url).length} video{vProjects.filter((p) => p.compiled_video_url).length === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-ink-700 divide-y divide-ink-700">
                    {vProjects.map((project, idx) => {
                      const hasVoice = !!(project.voiceover_url && project.voiceover_url.length > 0);
                      const isPlaying = playingProjectId === project.id;
                      return (
                        <div key={project.id} className="p-5">
                          <div className="flex items-start justify-between gap-4 mb-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs font-medium text-ink-500">Generation #{vProjects.length - idx}</span>
                                <span className="text-xs text-ink-600">·</span>
                                <span className="flex items-center gap-1 text-xs text-ink-500">
                                  <Clock className="w-3 h-3" />
                                  {formatDate(project.created_at)}
                                </span>
                              </div>
                              {project.script_tone && (
                                <p className="text-xs text-slate-400 mb-1">Tone: {project.script_tone}</p>
                              )}
                              <p className="text-xs text-ink-500">{wordCount(project.script_content)} words</p>
                            </div>
                            <button
                              onClick={() => handleDeleteProject(project.id)}
                              className="text-xs text-ink-500 hover:text-error-400 transition-colors shrink-0"
                            >
                              Delete
                            </button>
                          </div>

                          {/* Script preview */}
                          <div className="bg-ink-800 rounded-lg p-3 mb-3 max-h-40 overflow-y-auto">
                            <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">{project.script_content || 'No script content'}</p>
                          </div>

                          {/* Voiceover */}
                          {hasVoice ? (
                            <div className="flex items-center gap-3 bg-ink-800 rounded-lg p-3">
                              <button
                                onClick={() => togglePlay(project)}
                                className="w-9 h-9 rounded-full bg-brand-600 hover:bg-brand-500 flex items-center justify-center text-white transition-colors shrink-0"
                              >
                                {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
                              </button>
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-white">Voiceover audio</p>
                                <p className="text-xs text-ink-500 mt-0.5">{project.voiceover_voice || 'Unknown voice'}</p>
                              </div>
                              <a
                                href={downloadUrl(project.voiceover_url, `voiceover-${project.id}`)}
                                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-ink-700 transition-colors shrink-0"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </a>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 bg-ink-800 rounded-lg p-3">
                              <Volume2 className="w-4 h-4 text-ink-600 shrink-0" />
                              <p className="text-xs text-ink-500">No voiceover generated for this version</p>
                            </div>
                          )}

                          {/* Compiled video */}
                          {project.compiled_video_url ? (
                            <div className="mt-3">
                              <div className="flex items-center justify-between mb-2">
                                <p className="text-xs font-medium text-white flex items-center gap-1.5">
                                  <VideoIcon className="w-3.5 h-3.5 text-success-400" />
                                  Compiled Video
                                </p>
                                <a
                                  href={downloadUrl(project.compiled_video_url, `compiled-${project.id}`)}
                                  className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 font-medium"
                                >
                                  <Download className="w-3 h-3" />
                                  Download
                                </a>
                              </div>
                              <video
                                src={project.compiled_video_url}
                                controls
                                className="w-full rounded-lg"
                              />
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <audio
        ref={audioRef}
        onEnded={() => setPlayingProjectId(null)}
        className="hidden"
      />
    </div>
  );
}
