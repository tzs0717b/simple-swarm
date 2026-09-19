/*
 * "找一个信号… " 全局搜索面板：点顶部搜索框或按 / 打开。
 * 支持 ↑↓ 选择、Enter 跳转、Esc 关闭；结果按 集群/线程/智能体/消息 分组。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SearchHit, SearchResult } from "../data";
import { api } from "../lib/api";
import { agentColor } from "../lib/theme";

type GroupKey = "swarms" | "threads" | "agents" | "messages";

const GROUPS: { key: GroupKey; kind: SearchHit["kind"]; label: string }[] = [
  { key: "swarms", kind: "swarm", label: "集群" },
  { key: "threads", kind: "thread", label: "线程" },
  { key: "agents", kind: "agent", label: "智能体" },
  { key: "messages", kind: "message", label: "消息" },
];

function hrefOf(hit: SearchHit): string {
  if (hit.kind === "swarm") return `/swarms/${hit.swarmId}/threads`;
  if (hit.kind === "thread") return `/swarms/${hit.swarmId}/threads/${hit.threadId}`;
  if (hit.kind === "agent") return `/agents/${hit.id}`;
  return `/swarms/${hit.swarmId}/threads/${hit.threadId}`;
}

export default function SearchPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);

  /* 打开时聚焦并清空 */
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResult(null);
    setCursor(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(id);
  }, [open]);

  /* 防抖搜索 */
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResult(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = window.setTimeout(() => {
      api
        .search(trimmed)
        .then((payload) => {
          setResult(payload);
          setCursor(0);
        })
        .catch(() => setResult(null))
        .finally(() => setLoading(false));
    }, 140);
    return () => window.clearTimeout(id);
  }, [query]);

  /* 展平成可上下键导航的一行行 */
  const rows = useMemo(() => {
    if (!result) return [] as { hit: SearchHit; group: string }[];
    const out: { hit: SearchHit; group: string }[] = [];
    for (const group of GROUPS) {
      for (const hit of result[group.key]) out.push({ hit, group: group.label });
    }
    return out;
  }, [result]);

  if (!open) return null;

  function go(hit: SearchHit): void {
    onClose();
    navigate(hrefOf(hit));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (rows.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => (value + 1) % rows.length);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => (value - 1 + rows.length) % rows.length);
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[cursor];
      if (row) go(row.hit);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-[#1a1a1a]/25 px-4 pt-[88px]" onMouseDown={onClose}>
      <div
        className="mx-auto w-full max-w-[720px] overflow-hidden rounded-[6px] border border-[#dcdcd7] bg-[#fdfdfb] shadow-[0_12px_40px_rgba(0,0,0,0.18)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-[#ececea] px-3 py-2.5">
          <span className="text-[12px] text-[#b0b0aa]">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="找一个信号…  集群 / 线程 / 智能体 / 消息"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[#1a1a1a] outline-none placeholder:text-[#b0b0aa]"
          />
          <span className="mono shrink-0 text-[10px] text-[#b0b0aa]">
            {loading ? "搜索中…" : result ? `${result.total} 个结果` : "esc 关闭"}
          </span>
        </div>

        <div className="max-h-[58vh] overflow-y-auto">
          {rows.map((row, index) => {
            const active = index === cursor;
            return (
              <button
                key={`${row.hit.kind}-${row.hit.id}`}
                type="button"
                onMouseEnter={() => setCursor(index)}
                onClick={() => go(row.hit)}
                className={`flex w-full items-baseline gap-3 border-b border-[#f4f4f0] px-3 py-[7px] text-left last:border-b-0 ${
                  active ? "bg-[#f4f3ee]" : ""
                }`}
              >
                <span className="w-[42px] shrink-0 text-[9px] uppercase tracking-[0.1em] text-[#b0b0aa]">{row.group}</span>
                <span className="shrink-0">
                  {row.hit.kind === "agent" ? (
                    <span className="mono text-[12px]" style={{ color: agentColor(row.hit.agent) }}>
                      {row.hit.title}
                    </span>
                  ) : (
                    <span className="text-[12px] text-[#1a1a1a]">{row.hit.title}</span>
                  )}
                </span>
                <span className="mono min-w-0 flex-1 truncate text-[10px] text-[#9a9a95]">{row.hit.subtitle}</span>
                <span className="mono shrink-0 text-[10px] text-[#c4c4bf]">{row.hit.time}</span>
              </button>
            );
          })}

          {query.trim().length === 0 ? (
            <p className="px-3 py-6 text-center text-[11px] text-[#b0b0aa]">输入关键词开始搜索 · ↑↓ 选择 · Enter 打开</p>
          ) : null}
          {query.trim().length > 0 && !loading && rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-[11px] text-[#b0b0aa]">没有匹配的信号</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
