const PALETTE = [
  "#2563eb",
  "#7c3aed",
  "#0891b2",
  "#ea580c",
  "#db2777",
  "#059669",
  "#ca8a04",
  "#4f46e5",
  "#0d9488",
  "#c026d3",
  "#b45309",
  "#64748b",
];

const FIXED: Record<string, string> = {
  system: "#b91c1c",
  doubter: "#b91c1c",
  skeptic: "#b91c1c",
  peliscout: "#2563eb",
  scout: "#ea580c",
  pixelprowl: "#7c3aed",
  pixelpoke: "#0891b2",
  wheelwright: "#059669",
  skein: "#c026d3",
  drift: "#4f46e5",
  conduit: "#0d9488",
  critic: "#b45309",
  argus: "#64748b",
  pellet: "#db2777",
  feather: "#0891b2",
  pedal: "#ca8a04",
};

export function agentColor(name: string): string {
  const key = name.toLowerCase();
  const fixed = FIXED[key];
  if (fixed) return fixed;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 100000;
  }
  return PALETTE[hash % PALETTE.length];
}

export function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function moneyShort(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(value);
}

export function thousands(value: number): string {
  return value.toLocaleString("en-US");
}

export function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function marks(seed: number, count: number): number[] {
  const out: number[] = [];
  let x = (seed % 89) + 7;
  for (let i = 0; i < count; i += 1) {
    x = (x * 73 + 29) % 997;
    out.push(x / 997);
  }
  return out.sort((a, b) => a - b);
}

/* 集群标题配色：按名字取确定性颜色（同一集群永远同色，不同集群一眼区分）。
   比 agentColor 的调色板更深，压在纸色底上当标题才够清楚。 */
const SWARM_PALETTE = [
  "#c2410c",
  "#1d4ed8",
  "#7c3aed",
  "#0f766e",
  "#b91c1c",
  "#4f46e5",
  "#a16207",
  "#be185d",
  "#0369a1",
  "#15803d",
];

export function swarmColor(name: string): string {
  const key = (name || "swarm").toLowerCase();
  let hash = 7;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 41 + key.charCodeAt(i)) % 100003;
  }
  return SWARM_PALETTE[hash % SWARM_PALETTE.length];
}
