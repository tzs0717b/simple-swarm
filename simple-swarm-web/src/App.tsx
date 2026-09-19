import { useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Shell from "./components/Shell";
import SwarmsPage from "./pages/SwarmsPage";
import ThreadsPage, { AllThreadsPage } from "./pages/ThreadsPage";
import ThreadDetailPage from "./pages/ThreadDetailPage";
import SliceBoardPage from "./pages/SliceBoardPage";
import TracePage from "./pages/TracePage";
import AgentsPage from "./pages/AgentsPage";
import AgentDetailPage from "./pages/AgentDetailPage";
import { API_BASE } from "./lib/api";
import { boot, useStatus } from "./lib/store";

/* 启动闸门：先把后端数据水合进数据仓，再渲染界面 */
function BootGate({ children }: { children: ReactNode }) {
  const { phase, error } = useStatus();

  useEffect(() => {
    void boot();
  }, []);

  if (phase === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f9f9f7] px-6">
        <div className="w-full max-w-[560px] rounded-[5px] border border-[#f0c0bb] bg-[#fdeceb] px-4 py-4">
          <p className="text-[13px] font-semibold text-[#b91c1c]">连不上后端</p>
          <p className="mono mt-2 text-[11px] leading-5 text-[#a1553a]">{error}</p>
          <p className="mt-3 text-[11px] text-[#a1553a]">
            后端地址：<span className="mono">{API_BASE}</span>
            <br />
            启动方式：<span className="mono">cd simple-swarm-server && npm start</span>
          </p>
          <button
            type="button"
            onClick={() => void boot(true)}
            className="mt-3 rounded-[4px] border border-[#dcdcd7] bg-[#fdfdfb] px-3 py-[6px] text-[11px] uppercase tracking-[0.1em] text-[#5c5c58] hover:border-[#1a1a1a] hover:text-[#1a1a1a]"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (phase !== "ready") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f9f9f7]">
        <p className="mono text-[11px] uppercase tracking-[0.18em] text-[#9a9a95]">正在连接 swarm 后端…</p>
      </div>
    );
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <BootGate>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<Navigate to="/swarms" replace />} />
            <Route path="/swarms" element={<SwarmsPage />} />
            <Route path="/swarms/:swarmId/threads" element={<ThreadsPage />} />
            <Route path="/swarms/:swarmId/threads/:threadId" element={<ThreadDetailPage />} />
            <Route path="/swarms/:swarmId/slices" element={<SliceBoardPage />} />
            <Route path="/swarms/:swarmId/trace" element={<TracePage />} />
            <Route path="/swarms/:swarmId/agents" element={<AgentsPage />} />
            <Route path="/threads" element={<AllThreadsPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:name" element={<AgentDetailPage />} />
            <Route path="/swarms/:swarmId/agents/:name" element={<AgentDetailPage />} />
            <Route path="*" element={<Navigate to="/swarms" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </BootGate>
  );
}
