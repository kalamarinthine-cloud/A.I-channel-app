import { LayoutDashboard, Film, FileText, Clapperboard, Layers, FolderOpen, Wand2 } from 'lucide-react';

export type TabId = 'dashboard' | 'produce' | 'videos' | 'scripts' | 'broll' | 'assembly' | 'projects';

interface NavItem {
  id: TabId;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'produce', label: 'Produce', icon: Wand2 },
  { id: 'videos', label: 'Videos', icon: Film },
  { id: 'scripts', label: 'Scripts', icon: FileText },
  { id: 'broll', label: 'B-Roll', icon: Clapperboard },
  { id: 'assembly', label: 'Assembly', icon: Layers },
  { id: 'projects', label: 'Projects', icon: FolderOpen },
];

interface SidebarProps {
  active: TabId;
  onChange: (tab: TabId) => void;
}

export default function Sidebar({ active, onChange }: SidebarProps) {
  return (
    <aside className="w-64 shrink-0 border-r border-ink-700 bg-ink-900 flex flex-col">
      <div className="flex items-center gap-3 px-6 py-6 border-b border-ink-700">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center shadow-lg shadow-brand-600/20">
          <Clapperboard className="w-5 h-5 text-ink-950" />
        </div>
        <div>
          <h1 className="text-sm font-bold text-white tracking-tight">Film Central</h1>
          <p className="text-xs text-brand-400 font-medium">.ai</p>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onChange(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                isActive
                  ? 'bg-brand-600 text-white shadow-md shadow-brand-600/20'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-ink-800'
              }`}
            >
              <Icon className="w-4 h-4" />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="px-6 py-4 border-t border-ink-700">
        <p className="text-xs text-ink-500 leading-relaxed">
          Faceless YouTube pipeline manager
        </p>
      </div>
    </aside>
  );
}
