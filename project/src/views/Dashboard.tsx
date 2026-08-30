import { supabase, type Video, type BrollAsset, STATUS_ORDER, STATUS_LABELS, STATUS_COLORS } from '@/lib/supabase';
import { Film, FileText, CheckCircle2, Clock, TrendingUp, Plus } from 'lucide-react';
import { StatusBadge } from '@/components/StatusBadge';
import type { TabId } from '@/components/Sidebar';
import { useEffect, useState } from 'react';

interface DashboardProps {
  onNavigate: (tab: TabId) => void;
  refreshKey: number;
}

export default function Dashboard({ onNavigate, refreshKey }: DashboardProps) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [assets, setAssets] = useState<BrollAsset[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: v }, { data: a }] = await Promise.all([
        supabase.from('videos').select('*').order('updated_at', { ascending: false }),
        supabase.from('broll_assets').select('*'),
      ]);
      setVideos(v ?? []);
      setAssets(a ?? []);
      setLoading(false);
    })();
  }, [refreshKey]);

  const published = videos.filter((v) => v.status === 'published').length;
  const inProgress = videos.filter((v) => v.status !== 'published' && v.status !== 'idea').length;
  const assetsNeeded = assets.filter((a) => a.status === 'needed').length;

  const stats = [
    { label: 'Total Videos', value: videos.length, icon: Film, color: 'text-brand-400', bg: 'bg-brand-600/10' },
    { label: 'In Progress', value: inProgress, icon: Clock, color: 'text-warning-400', bg: 'bg-warning-500/10' },
    { label: 'Published', value: published, icon: CheckCircle2, color: 'text-success-400', bg: 'bg-success-500/10' },
    { label: 'Assets Needed', value: assetsNeeded, icon: TrendingUp, color: 'text-error-400', bg: 'bg-error-500/10' },
  ];

  const pipelineCounts = STATUS_ORDER.map((status) => ({
    status,
    count: videos.filter((v) => v.status === status).length,
  }));

  const recent = videos.slice(0, 5);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Dashboard</h2>
          <p className="text-sm text-slate-400 mt-1">Overview of your faceless YouTube pipeline</p>
        </div>
        <button
          onClick={() => onNavigate('videos')}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors shadow-md shadow-brand-600/20"
        >
          <Plus className="w-4 h-4" />
          New Video
        </button>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className="bg-ink-850 border border-ink-700 rounded-xl p-5 hover:border-ink-600 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">{stat.label}</p>
                  <p className="text-3xl font-bold text-white mt-2">{loading ? '—' : stat.value}</p>
                </div>
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${stat.bg}`}>
                  <Icon className={`w-6 h-6 ${stat.color}`} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pipeline overview */}
      <div className="bg-ink-850 border border-ink-700 rounded-xl p-6">
        <h3 className="text-sm font-semibold text-white mb-4">Pipeline Overview</h3>
        <div className="grid grid-cols-5 gap-3">
          {pipelineCounts.map(({ status, count }) => (
            <button
              key={status}
              onClick={() => onNavigate('videos')}
              className="flex flex-col items-center gap-2 p-4 rounded-lg bg-ink-800 hover:bg-ink-700 transition-colors"
            >
              <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${STATUS_COLORS[status]}`}>
                {STATUS_LABELS[status]}
              </span>
              <span className="text-2xl font-bold text-white">{count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Recent videos */}
      <div className="bg-ink-850 border border-ink-700 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">Recent Activity</h3>
          <button
            onClick={() => onNavigate('videos')}
            className="text-xs text-brand-400 hover:text-brand-300 font-medium"
          >
            View all →
          </button>
        </div>
        {loading ? (
          <p className="text-sm text-slate-400 py-4 text-center">Loading…</p>
        ) : recent.length === 0 ? (
          <div className="text-center py-8">
            <FileText className="w-10 h-10 text-ink-600 mx-auto mb-3" />
            <p className="text-sm text-slate-400">No videos yet. Create your first one to get started.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {recent.map((video) => (
              <div
                key={video.id}
                className="flex items-center justify-between px-4 py-3 rounded-lg bg-ink-800 hover:bg-ink-700 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white truncate">{video.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {video.niche} · {video.runtime}
                  </p>
                </div>
                <StatusBadge status={video.status} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
