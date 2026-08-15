import { supabase, type Video, type VideoStatus, type Runtime, RUNTIME_OPTIONS, STATUS_ORDER } from '@/lib/supabase';
import { NICHES, type Niche } from '@/lib/constants';
import { StatusStepper } from '@/components/StatusBadge';
import Modal from '@/components/Modal';
import { Plus, Trash2, Search, Film, Filter } from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';

interface VideosProps {
  onRefresh: () => void;
}

export default function Videos({ onRefresh }: VideosProps) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<VideoStatus | 'all'>('all');
  const [nicheFilter, setNicheFilter] = useState<string>('all');
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Video | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('videos').select('*').order('updated_at', { ascending: false });
    setVideos(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = videos.filter((v) => {
    const matchSearch = v.title.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || v.status === statusFilter;
    const matchNiche = nicheFilter === 'all' || v.niche === nicheFilter;
    return matchSearch && matchStatus && matchNiche;
  });

  const handleAdd = async (data: Partial<Video>) => {
    await supabase.from('videos').insert({
      title: data.title,
      niche: data.niche,
      runtime: data.runtime,
      status: 'idea',
      script_content: '',
      notes: data.notes ?? '',
    });
    setShowAdd(false);
    await load();
    onRefresh();
  };

  const handleStatusChange = async (video: Video, status: VideoStatus) => {
    await supabase.from('videos').update({ status, updated_at: new Date().toISOString() }).eq('id', video.id);
    await load();
    onRefresh();
  };

  const handleDelete = async (id: string) => {
    await supabase.from('videos').delete().eq('id', id);
    await load();
    onRefresh();
  };

  const handleEditNotes = async (video: Video, notes: string) => {
    await supabase.from('videos').update({ notes, updated_at: new Date().toISOString() }).eq('id', video.id);
    await load();
    onRefresh();
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Videos</h2>
          <p className="text-sm text-slate-400 mt-1">Manage your production pipeline</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors shadow-md shadow-brand-600/20"
        >
          <Plus className="w-4 h-4" />
          New Video
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-500" />
          <input
            type="text"
            placeholder="Search videos…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-ink-850 border border-ink-700 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-brand-500 transition-colors"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-ink-500" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as VideoStatus | 'all')}
            className="px-3 py-2.5 rounded-lg bg-ink-850 border border-ink-700 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors"
          >
            <option value="all">All Statuses</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>{s.replace('_', ' ')}</option>
            ))}
          </select>
          <select
            value={nicheFilter}
            onChange={(e) => setNicheFilter(e.target.value)}
            className="px-3 py-2.5 rounded-lg bg-ink-850 border border-ink-700 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors"
          >
            <option value="all">All Niches</option>
            {NICHES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Video list */}
      {loading ? (
        <p className="text-sm text-slate-400 py-8 text-center">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <Film className="w-12 h-12 text-ink-600 mx-auto mb-4" />
          <p className="text-sm text-slate-400 mb-1">No videos found</p>
          <p className="text-xs text-ink-500">Create a new video or adjust your filters</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((video) => (
            <div
              key={video.id}
              className="bg-ink-850 border border-ink-700 rounded-xl p-5 hover:border-ink-600 transition-colors"
            >
              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold text-white">{video.title}</h3>
                  <div className="flex items-center gap-3 mt-1.5">
                    <span className="text-xs px-2 py-0.5 rounded-md bg-ink-700 text-slate-300">{video.niche}</span>
                    <span className="text-xs text-ink-500">{video.runtime}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setEditing(video)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 bg-ink-700 hover:bg-ink-600 transition-colors"
                  >
                    Notes
                  </button>
                  <button
                    onClick={() => handleDelete(video.id)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-error-400 hover:bg-error-500/10 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="pt-3 border-t border-ink-700">
                <p className="text-xs text-ink-500 mb-2 font-medium uppercase tracking-wide">Pipeline Stage</p>
                <StatusStepper current={video.status} onStepClick={(s) => handleStatusChange(video, s)} />
              </div>

              {video.notes && (
                <div className="mt-3 pt-3 border-t border-ink-700">
                  <p className="text-xs text-ink-500 mb-1 font-medium uppercase tracking-wide">Notes</p>
                  <p className="text-sm text-slate-300 whitespace-pre-wrap">{video.notes}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add modal */}
      <AddVideoModal open={showAdd} onClose={() => setShowAdd(false)} onAdd={handleAdd} />

      {/* Notes edit modal */}
      <NotesModal video={editing} onClose={() => setEditing(null)} onSave={handleEditNotes} />
    </div>
  );
}

function AddVideoModal({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (data: Partial<Video>) => void }) {
  const [title, setTitle] = useState('');
  const [niche, setNiche] = useState<Niche>('Tech/AI');
  const [runtime, setRuntime] = useState<Runtime>('Medium (2-8 min)');
  const [notes, setNotes] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onAdd({ title: title.trim(), niche, runtime, notes: notes.trim() });
    setTitle('');
    setNotes('');
    setNiche('Tech/AI');
    setRuntime('Medium (2-8 min)');
  };

  return (
    <Modal open={open} onClose={onClose} title="New Video">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. How AI Will Replace 40% of Office Jobs"
            autoFocus
            className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-brand-500 transition-colors"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Niche</label>
            <select
              value={niche}
              onChange={(e) => setNiche(e.target.value as Niche)}
              className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors"
            >
              {NICHES.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Runtime</label>
            <select
              value={runtime}
              onChange={(e) => setRuntime(e.target.value as Runtime)}
              className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors"
            >
              {RUNTIME_OPTIONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any initial thoughts, angle, or research links…"
            rows={3}
            className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-brand-500 transition-colors resize-none"
          />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button type="submit" className="px-5 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-500 text-white transition-colors">
            Create Video
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NotesModal({ video, onClose, onSave }: { video: Video | null; onClose: () => void; onSave: (video: Video, notes: string) => void }) {
  const [notes, setNotes] = useState('');

  useEffect(() => {
    setNotes(video?.notes ?? '');
  }, [video]);

  if (!video) return null;

  const handleSave = () => {
    onSave(video, notes.trim());
    onClose();
  };

  return (
    <Modal open={!!video} onClose={onClose} title={`Notes: ${video.title}`}>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Research links, angle ideas, talking points…"
            rows={8}
            className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-brand-500 transition-colors resize-none"
          />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} className="px-5 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-500 text-white transition-colors">
            Save Notes
          </button>
        </div>
      </div>
    </Modal>
  );
}
