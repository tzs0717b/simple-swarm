import { agentColor } from "../lib/theme";
import type { ThreadData } from "../data";

/* 每个成员一条轨迹，点数 = 该成员在本集群的**真实工作步数**（count）。
   后端按"工具调用/思考"算，网关重试与系统跳过不算 —— 点的是干活，不是发言。 */
export default function Timeline({ thread }: { thread: ThreadData }) {
  const rows = thread.members;   /* 不再按 compact 截断人数 */
  const maxCount = Math.max(1, ...rows.map((member) => member.count));
  return (
    <div className="space-y-[3px]">
      {rows.map((member) => {
        const color = agentColor(member.name);
        const total = Math.max(0, member.count);
        return (
          <div key={member.name} className="relative h-[9px] w-full">
            <div className="absolute top-1/2 h-[1px] w-full -translate-y-1/2 bg-[#e2e2de]" />
            {Array.from({ length: total }).map((_, point) => {
              const t = total === 1 ? 0.5 : point / (total - 1);
              const left = 2 + t * 96;
              return (
                <span
                  key={member.name + "-" + point}
                  className="absolute top-1/2 h-[6px] w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full ring-1 ring-white"
                  style={{ left: left + "%", background: color, opacity: 0.45 + 0.55 * (member.count / maxCount) }}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
