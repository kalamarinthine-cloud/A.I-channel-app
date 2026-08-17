import { downloadUrl, supabase, type Video, type Runtime, type ElevenVoice, type ScriptProject, generateScript, generateVoiceover, listVoices } from '@/lib/supabase';
import { StatusBadge } from '@/components/StatusBadge';
import Modal from '@/components/Modal';
import { FileText, Save, Check, Clock, Hash, Sparkles, Volume2, Loader2, Play, Pause, Download, AlertCircle } from 'lucide-react';
import { useEffect, useState, useCallback, useRef } from 'react';

interface ScriptsProps {
  onRefresh: () => void;
}

export default function Scripts({ onRefresh }: ScriptsProps) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Script generation state
  const [showGen, setShowGen] = useState(false);
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState('');
  const [genTone, setGenTone] = useState('informative and engaging');
  const [genInstructions, setGenInstructions] = useState('');

  // Voiceover state
  const [showTts, setShowTts] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState('');
  const [voices, setVoices] = useState<ElevenVoice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('');
  const [audioUrl, setAudioUrl] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Projects for the selected video
  const [projects, setProjects] = useState<ScriptProject[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('videos').select('*').order('updated_at', { ascending: false });
    setVideos(data ?? []);
    if (data && data.length > 0 && !selectedId) {
      setSelectedId(data[0].id);
    }
    setLoading(false);
  }, [selectedId]);

  // Load projects for the selected video
  useEffect(() => {
    if (!selectedId) {
      setProjects([]);
      return;
    }
    (async () => {
      const { data } = await supabase
        .from('script_projects')
        .select('*')
        .eq('video_id', selectedId)
        .order('created_at', { ascending: false });
      setProjects(data ?? []);
    })();
  }, [selectedId]);

  useEffect(() => { load(); }, [load]);

  const selected = videos.find((v) => v.id === selectedId) ?? null;

  useEffect(() => {
    setDraft(selected?.script_content ?? '');
    setSaved(false);
    setAudioUrl(selected?.voiceover_url ?? '');
    setSelectedVoiceId(selected?.voiceover_voice ?? '');
  }, [selectedId, selected?.script_content, selected?.voiceover_url, selected?.voiceover_voice]);

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    await supabase
      .from('videos')
      .update({ script_content: draft, updated_at: new Date().toISOString() })
      .eq('id', selected.id);
    setSaving(false);
    setSaved(true);
    onRefresh();
    setTimeout(() => setSaved(false), 2000);
  };

  const handleGenerate = async () => {
    if (!selected) return;
    setGenLoading(true);
    setGenError('');
    const { script, error } = await generateScript({
      title: selected.title,
      niche: selected.niche,
      runtime: selected.runtime as Runtime,
      tone: genTone,
      instructions: genInstructions,
    });
    setGenLoading(false);
    if (error) {
      setGenError(error);
      return;
    }
    if (script) {
      setDraft(script);
      const now = new Date().toISOString();
      await supabase
        .from('videos')
        .update({ script_content: script, status: 'script_ready', updated_at: now })
        .eq('id', selected.id);
      // Create a project row for this generation
      const { data: newProject } = await supabase
        .from('script_projects')
        .insert({
          video_id: selected.id,
          script_content: script,
          script_tone: genTone,
          script_instructions: genInstructions,
        })
        .select()
        .single();
      if (newProject) {
        setProjects((prev) => [newProject, ...prev]);
      }
      onRefresh();
    }
    setShowGen(false);
    setGenInstructions('');
  };

  const handleOpenTts = async () => {
    setShowTts(true);
    setTtsError('');
    if (voices.length === 0) {
      const { voices: v, error } = await listVoices();
      if (error) {
        setTtsError(error);
        return;
      }
      setVoices(v ?? []);
      if (v && v.length > 0 && !selectedVoiceId) {
        setSelectedVoiceId(v[0].voiceId);
      }
    }
  };

  const handleTts = async () => {
    if (!selected || !draft.trim() || !selectedVoiceId) return;
    setTtsLoading(true);
    setTtsError('');
    const { url, error } = await generateVoiceover({ text: draft, voiceId: selectedVoiceId, videoId: selected.id });
    setTtsLoading(false);
    if (error) {
      setTtsError(error);
      return;
    }
    if (url) {
      setAudioUrl(url);
      const now = new Date().toISOString();
      await supabase
        .from('videos')
        .update({ voiceover_url: url, voiceover_voice: selectedVoiceId, updated_at: now })
        .eq('id', selected.id);
      // Attach voiceover to the latest project for this video
      if (projects.length > 0) {
        await supabase
          .from('script_projects')
          .update({ voiceover_url: url, voiceover_voice: selectedVoiceId })
          .eq('id', projects[0].id);
        setProjects((prev) => prev.map((p, i) => i === 0 ? { ...p, voiceover_url: url, voiceover_voice: selectedVoiceId } : p));
      }
      onRefresh();
    }
    setShowTts(false);
  };

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

  const wordCount = draft.trim() ? draft.trim().split(/\s+/).length : 0;
  const charCount = draft.length;
  const readTime = Math.max(1, Math.ceil(wordCount / 150));

  const selectedVoiceName = voices.find((v) => v.voiceId === selectedVoiceId)?.name ?? 'Selected voice';

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-bold text-white">Scripts</h2>
        <p className="text-sm text-slate-400 mt-1">Generate scripts with AI and create voiceovers with ElevenLabs</p>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400 py-8 text-center">Loading…</p>
      ) : videos.length === 0 ? (
        <div className="text-center py-16">
          <FileText className="w-12 h-12 text-ink-600 mx-auto mb-4" />
          <p className="text-sm text-slate-400">No videos yet. Create one in the Videos tab first.</p>
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4 h-[calc(100vh-180px)]">
          {/* Video list */}
          <div className="col-span-4 lg:col-span-3 space-y-2 overflow-y-auto pr-1">
            {videos.map((video) => {
              const hasScript = video.script_content && video.script_content.trim().length > 0;
              const hasVoice = video.voiceover_url && video.voiceover_url.length > 0;
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
                    <StatusBadge status={video.status} />
                    {hasScript && (
                      <span className="flex items-center gap-1 text-xs text-success-400">
                        <Check className="w-3 h-3" />Script
                      </span>
                    )}
                    {hasVoice && (
                      <span className="flex items-center gap-1 text-xs text-brand-400">
                        <Volume2 className="w-3 h-3" />Voice
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Editor */}
          <div className="col-span-8 lg:col-span-9 flex flex-col bg-ink-850 border border-ink-700 rounded-xl overflow-hidden">
            {selected ? (
              <>
                <div className="flex items-center justify-between px-5 py-4 border-b border-ink-700">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-white truncate">{selected.title}</h3>
                    <p className="text-xs text-ink-500 mt-0.5">{selected.niche} · {selected.runtime}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowGen(true)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-brand-300 bg-brand-600/15 hover:bg-brand-600/25 transition-colors"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Generate
                    </button>
                    <button
                      onClick={handleOpenTts}
                      disabled={!draft.trim()}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-accent-600 bg-accent-500/15 hover:bg-accent-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                      Voiceover
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50"
                    >
                      {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                      {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
                    </button>
                  </div>
                </div>

                {/* Voiceover player */}
                {audioUrl && (
                  <div className="flex items-center gap-3 px-5 py-3 bg-ink-900 border-b border-ink-700">
                    <button
                      onClick={togglePlay}
                      className="w-9 h-9 rounded-full bg-brand-600 hover:bg-brand-500 flex items-center justify-center text-white transition-colors"
                    >
                      {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-300">Voiceover ready</p>
                      <p className="text-xs text-ink-500">Voice: {selectedVoiceName}</p>
                    </div>
                    <audio
                      ref={audioRef}
                      src={audioUrl}
                      onEnded={() => setIsPlaying(false)}
                      className="hidden"
                    />
                    <a
                      href={downloadUrl(audioUrl, `voiceover-${selected.title}`)}
                      className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-ink-700 transition-colors"
                    >
                      <Download className="w-4 h-4" />
                    </a>
                  </div>
                )}

                <div className="flex-1 overflow-y-auto p-5">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Paste or write your script here…&#10;&#10;Or click 'Generate' to have AI write one for you.&#10;&#10;[INTRO]&#10;Did you know that AI is now doing the work of…"
                    className="w-full h-full bg-transparent text-sm text-slate-200 placeholder-ink-500 focus:outline-none resize-none"
                    style={{ minHeight: '300px' }}
                  />
                </div>

                <div className="flex items-center gap-5 px-5 py-3 border-t border-ink-700 bg-ink-900">
                  <span className="flex items-center gap-1.5 text-xs text-ink-500">
                    <Hash className="w-3.5 h-3.5" />
                    {wordCount} words
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-ink-500">
                    <FileText className="w-3.5 h-3.5" />
                    {charCount} chars
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-ink-500">
                    <Clock className="w-3.5 h-3.5" />
                    ~{readTime} min read
                  </span>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-sm text-slate-400">Select a video to edit its script</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Generate Script Modal */}
      <Modal open={showGen} onClose={() => setShowGen(false)} title="Generate Script with AI" maxWidth="max-w-lg">
        <div className="space-y-4">
          {genError && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-error-500/10 border border-error-500/30">
              <AlertCircle className="w-4 h-4 text-error-400 shrink-0 mt-0.5" />
              <p className="text-xs text-error-400">{genError}</p>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Tone</label>
            <input
              type="text"
              value={genTone}
              onChange={(e) => setGenTone(e.target.value)}
              placeholder="e.g. informative and engaging, dramatic, conversational"
              className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-brand-500 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Additional Instructions (optional)</label>
            <textarea
              value={genInstructions}
              onChange={(e) => setGenInstructions(e.target.value)}
              placeholder="e.g. Focus on the impact on blue-collar workers. Mention specific companies. Include a call to action to subscribe."
              rows={4}
              className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-brand-500 transition-colors resize-none"
            />
          </div>
          <div className="p-3 rounded-lg bg-ink-800 border border-ink-700">
            <p className="text-xs text-ink-500">
              The AI will generate a script for <span className="text-slate-300 font-medium">{selected?.title}</span> in the <span className="text-slate-300 font-medium">{selected?.niche}</span> niche, targeted at <span className="text-slate-300 font-medium">{selected?.runtime}</span> runtime. This will replace any existing script content.
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setShowGen(false)} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition-colors">
              Cancel
            </button>
            <button
              onClick={handleGenerate}
              disabled={genLoading}
              className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50"
            >
              {genLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {genLoading ? 'Generating…' : 'Generate Script'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Voiceover Modal */}
      <Modal open={showTts} onClose={() => setShowTts(false)} title="Generate Voiceover" maxWidth="max-w-lg">
        <div className="space-y-4">
          {ttsError && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-error-500/10 border border-error-500/30">
              <AlertCircle className="w-4 h-4 text-error-400 shrink-0 mt-0.5" />
              <p className="text-xs text-error-400">{ttsError}</p>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Voice</label>
            {voices.length === 0 && !ttsError ? (
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700">
                <Loader2 className="w-4 h-4 animate-spin text-brand-400" />
                <span className="text-sm text-ink-500">Loading voices…</span>
              </div>
            ) : (
              <select
                value={selectedVoiceId}
                onChange={(e) => setSelectedVoiceId(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors"
              >
                {voices.map((v) => (
                  <option key={v.voiceId} value={v.voiceId}>
                    {v.name}{v.category ? ` (${v.category})` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="p-3 rounded-lg bg-ink-800 border border-ink-700">
            <p className="text-xs text-ink-500">
              ElevenLabs will convert your script ({wordCount} words) into an MP3 voiceover using the selected voice. The first 5,000 characters will be used.
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setShowTts(false)} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition-colors">
              Cancel
            </button>
            <button
              onClick={handleTts}
              disabled={ttsLoading || !selectedVoiceId}
              className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium bg-accent-500 hover:bg-accent-400 text-ink-950 transition-colors disabled:opacity-50"
            >
              {ttsLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
              {ttsLoading ? 'Generating…' : 'Generate Voiceover'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
