import { useState } from 'react';
import Sidebar, { type TabId } from '@/components/Sidebar';
import Dashboard from '@/views/Dashboard';
import Produce from '@/views/Produce';
import Videos from '@/views/Videos';
import Scripts from '@/views/Scripts';
import Broll from '@/views/Broll';
import Assembly from '@/views/Assembly';
import Projects from '@/views/Projects';

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('produce');
  const [refreshKey, setRefreshKey] = useState(0);

  const triggerRefresh = () => setRefreshKey((k) => k + 1);

  return (
    <div className="flex h-screen bg-ink-950 overflow-hidden">
      <Sidebar active={activeTab} onChange={setActiveTab} />
      <main className="flex-1 overflow-y-auto p-8">
        {activeTab === 'dashboard' && <Dashboard onNavigate={setActiveTab} refreshKey={refreshKey} />}
        {activeTab === 'produce' && <Produce onRefresh={triggerRefresh} />}
        {activeTab === 'videos' && <Videos onRefresh={triggerRefresh} />}
        {activeTab === 'scripts' && <Scripts onRefresh={triggerRefresh} />}
        {activeTab === 'broll' && <Broll onRefresh={triggerRefresh} />}
        {activeTab === 'assembly' && <Assembly onRefresh={triggerRefresh} />}
        {activeTab === 'projects' && <Projects onRefresh={triggerRefresh} />}
      </main>
    </div>
  );
}

export default App;
