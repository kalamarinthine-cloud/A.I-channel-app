import { supabase, type Video, type BrollAsset, type AssetType, type AssetStatus, type BrollSearchResult, ASSET_TYPE_LABELS, ASSET_STATUS_COLORS, searchBroll } from '@/lib/supabase';
import Modal from '@/components/Modal';
import { Plus, Trash2, ExternalLink, Clapperboard, Image, Music, Monitor, Volume2, Film as FilmIcon, Search, Loader2, AlertCircle, Check } from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';

interface BrollProps {
  onRefresh: () => void;
}

const ASSET_TYPE_ICONS: Record<AssetType, typeof FilmIcon> = {
  footage: FilmIcon,
  image: Image,
  screen_recording: Monitor,
  music: Music,
  sfx: Volume2,
};

export default function Broll({ onRefresh }: BrollProps) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [assets, setAssets] = useState<BrollAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: v }, { data: a }] = await Promise.all([
      supabase.from('videos').select('*').order('updated_at', { ascending: false }),
      supabase.from('broll_assets').select('*'),
    ]);
    setVideos(v ?? []);
    setAssets(a ?? []);
    if (v && v.length > 0 && !selectedVideoId) {
      setSelectedVideoId(v[0].id);
    }
    setLoading(false);
  }, [selectedVideoId]);

  useEffect(() => { load(); }, [load]);

  const selectedVideo = videos.find((v) => v.id === selectedVideoId) ?? null;
  const videoAssets = assets.filter((a) => a.video_id === selectedVideoId);

  const handleAddAsset = async (data: { label: string; type: AssetType; source_url: string }) => {
    if (!selectedVideoId) return;
    await supabase.from('broll_assets').insert({
      video_id: selectedVideoId,
      label: data.label,
      type: data.type,
      source_url: data.source_url,
      status: 'needed',
    });
    setShowAdd(false);
    await load();
    onRefresh();
  };

  const handleImportFromSearch = async (result: BrollSearchResult, label: string) => {
    if (!selectedVideoId || !result.videoUrl) return;
    await supabase.from('broll_assets').insert({
      video_id: selectedVideoId,
      label,
      type: 'footage',
      source_url: result.videoUrl,
      status: 'sourced',
    });
    await load();
    onRefresh();
  };

  const handleStatusChange = async (asset: BrollAsset, status: AssetStatus) => {
    await supabase.from('broll_assets').update({ status }).eq('id', asset.id);
    await load();
    onRefresh();
  };

  const handleDelete = async (id: string) => {
    await supabase.from('broll_assets').delete().eq('id', id);
    await load();
    onRefresh();
  };

  const assetCounts = (vid: Video) => {
    const vidAssets = assets.filter((a) => a.video_id === vid.id);
    return {
      total: vidAssets.length,
      needed: vidAssets.filter((a) => a.status === 'needed').length,
      ready: vidAssets.filter((a) => a.status === 'ready').length,
    };
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">B-Roll</h2>
          <p className="text-sm text-slate-400 mt-1">Search stock footage, track assets, and manage your visual library</p>
        </div>
        {selectedVideoId && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSearch(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-brand-300 bg-brand-600/15 hover:bg-brand-600/25 transition-colors"
            >
              <Search className="w-4 h-4" />
              Search Footage
            </button>
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors shadow-md shadow-brand-600/20"
            >
              <Plus className="w-4 h-4" />
              Add Asset
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-slate-400 py-8 text-center">Loading…</p>
      ) : videos.length === 0 ? (
        <div className="text-center py-16">
          <Clapperboard className="w-12 h-12 text-ink-600 mx-auto mb-4" />
          <p className="text-sm text-slate-400">No videos yet. Create one in the Videos tab first.</p>
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {/* Video list */}
          <div className="col-span-4 lg:col-span-3 space-y-2">
            {videos.map((video) => {
              const counts = assetCounts(video);
              const isSelected = video.id === selectedVideoId;
              return (
                <button
                  key={video.id}
                  onClick={() => setSelectedVideoId(video.id)}
                  className={`w-full text-left p-4 rounded-xl border transition-all ${
                    isSelected
                      ? 'bg-ink-800 border-brand-500 shadow-md shadow-brand-600/10'
                      : 'bg-ink-850 border-ink-700 hover:border-ink-600'
                  }`}
                >
                  <p className="text-sm font-medium text-white truncate">{video.title}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-xs text-ink-500">{counts.total} assets</span>
                    {counts.needed > 0 && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-error-500/15 text-error-400">{counts.needed} needed</span>
                    )}
                    {counts.ready > 0 && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-success-500/15 text-success-400">{counts.ready} ready</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Asset grid */}
          <div className="col-span-8 lg:col-span-9">
            {selectedVideo ? (
              videoAssets.length === 0 ? (
                <div className="bg-ink-850 border border-ink-700 rounded-xl p-12 text-center">
                  <Clapperboard className="w-10 h-10 text-ink-600 mx-auto mb-3" />
                  <p className="text-sm text-slate-400 mb-1">No assets tracked yet</p>
                  <p className="text-xs text-ink-500 mb-4">Search for stock footage or add assets manually</p>
                  <div className="flex items-center justify-center gap-2">
                    <button
                      onClick={() => setShowSearch(true)}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-brand-300 bg-brand-600/15 hover:bg-brand-600/25 transition-colors"
                    >
                      <Search className="w-4 h-4" />
                      Search Footage
                    </button>
                    <button
                      onClick={() => setShowAdd(true)}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-500 text-white transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      Add Manually
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {videoAssets.map((asset) => {
                    const Icon = ASSET_TYPE_ICONS[asset.type];
                    return (
                      <div
                        key={asset.id}
                        className="bg-ink-850 border border-ink-700 rounded-xl p-4 hover:border-ink-600 transition-colors group"
                      >
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="flex items-start gap-3 min-w-0 flex-1">
                            <div className="w-9 h-9 rounded-lg bg-ink-700 flex items-center justify-center shrink-0">
                              <Icon className="w-4 h-4 text-brand-400" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-white truncate">{asset.label}</p>
                              <p className="text-xs text-ink-500 mt-0.5">{ASSET_TYPE_LABELS[asset.type]}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => handleDelete(asset.id)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-error-400 hover:bg-error-500/10 transition-colors opacity-0 group-hover:opacity-100"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {asset.source_url && (
                          <a
                            href={asset.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 text-xs text-brand-400 hover:text-brand-300 mb-3 truncate"
                          >
                            <ExternalLink className="w-3 h-3 shrink-0" />
                            <span className="truncate">{asset.source_url}</span>
                          </a>
                        )}

                        <div className="flex items-center gap-1.5">
                          {(['needed', 'sourced', 'ready'] as AssetStatus[]).map((s) => (
                            <button
                              key={s}
                              onClick={() => handleStatusChange(asset, s)}
                              className={`flex-1 py-1.5 rounded-lg text-xs font-medium capitalize transition-all ${
                                asset.status === s
                                  ? `${ASSET_STATUS_COLORS[s]} shadow-sm`
                                  : 'bg-ink-800 text-ink-500 hover:bg-ink-700'
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
              )
            ) : (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-slate-400">Select a video to manage its assets</p>
              </div>
            )}
          </div>
        </div>
      )}

      <AddAssetModal open={showAdd} onClose={() => setShowAdd(false)} onAdd={handleAddAsset} videoTitle={selectedVideo?.title ?? ''} />
      <BrollSearchModal
        open={showSearch}
        onClose={() => setShowSearch(false)}
        onImport={handleImportFromSearch}
        videoTitle={selectedVideo?.title ?? ''}
      />
    </div>
  );
}

function AddAssetModal({ open, onClose, onAdd, videoTitle }: { open: boolean; onClose: () => void; onAdd: (data: { label: string; type: AssetType; source_url: string }) => void; videoTitle: string }) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<AssetType>('footage');
  const [sourceUrl, setSourceUrl] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    onAdd({ label: label.trim(), type, source_url: sourceUrl.trim() });
    setLabel('');
    setSourceUrl('');
    setType('footage');
  };

  return (
    <Modal open={open} onClose={onClose} title={`Add Asset${videoTitle ? ` — ${videoTitle}` : ''}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Factory automation footage, AI robot B-roll"
            autoFocus
            className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-brand-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as AssetType)}
            className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors"
          >
            {(Object.entries(ASSET_TYPE_LABELS) as [AssetType, string][]).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">Source URL (optional)</label>
          <input
            type="text"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://pexels.com/… or stock library link"
            className="w-full px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-brand-500 transition-colors"
          />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button type="submit" className="px-5 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-500 text-white transition-colors">
            Add Asset
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BrollSearchModal({ open, onClose, onImport, videoTitle }: { open: boolean; onClose: () => void; onImport: (result: BrollSearchResult, label: string) => void; videoTitle: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<BrollSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [importedIds, setImportedIds] = useState<Set<number>>(new Set());

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError('');
    setResults([]);
    const { results: data, error: err } = await searchBroll({ query: query.trim(), perPage: 8 });
    setSearching(false);
    if (err) {
      setError(err);
      return;
    }
    setResults(data ?? []);
  };

  const handleImport = (result: BrollSearchResult) => {
    const label = query.trim();
    onImport(result, label);
    setImportedIds((prev) => new Set(prev).add(result.id));
  };

  const handleClose = () => {
    setQuery('');
    setResults([]);
    setError('');
    setImportedIds(new Set());
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title={`Search Stock Footage${videoTitle ? ` — ${videoTitle}` : ''}`} maxWidth="max-w-2xl">
      <div className="space-y-4">
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for footage… e.g. AI robot, factory automation, office workers"
            autoFocus
            className="flex-1 px-4 py-2.5 rounded-lg bg-ink-800 border border-ink-700 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-brand-500 transition-colors"
          />
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50"
          >
            {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-error-500/10 border border-error-500/30">
            <AlertCircle className="w-4 h-4 text-error-400 shrink-0 mt-0.5" />
            <p className="text-xs text-error-400">{error}</p>
          </div>
        )}

        {results.length > 0 && (
          <div className="grid grid-cols-2 gap-3 max-h-[400px] overflow-y-auto pr-1">
            {results.map((result) => {
              const isImported = importedIds.has(result.id);
              return (
                <div
                  key={result.id}
                  className="bg-ink-800 border border-ink-700 rounded-xl overflow-hidden group"
                >
                  {result.thumbnail && (
                    <div className="relative aspect-video bg-ink-900">
                      <img
                        src={result.thumbnail}
                        alt={query}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                      <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/70 text-xs text-white font-mono">
                        {result.duration}s
                      </span>
                    </div>
                  )}
                  <div className="p-3">
                    <button
                      onClick={() => handleImport(result)}
                      disabled={isImported || !result.videoUrl}
                      className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors ${
                        isImported
                          ? 'bg-success-500/15 text-success-400 cursor-default'
                          : 'bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-40'
                      }`}
                    >
                      {isImported ? (
                        <><Check className="w-3.5 h-3.5" /> Imported</>
                      ) : (
                        <><Plus className="w-3.5 h-3.5" /> Import as Asset</>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!searching && results.length === 0 && !error && query && (
          <p className="text-xs text-ink-500 text-center py-4">No results yet. Try a search above.</p>
        )}
      </div>
    </Modal>
  );
}
