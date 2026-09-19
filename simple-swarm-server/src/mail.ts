/*
 * 邮箱地址与投递规则 —— 纯函数，不碰存储。
 *
 * 地址格式：<local>@<swarmId>.swarm     例如 peliscout@perfect-pelican.swarm
 *   每个集群一个域 → 跨集群同名（名字池只保证同集群不重名）不会串信。
 *
 * 两类特殊 local：
 *   别名（不占邮箱，发信时展开）：all / agents / humans
 *   共享邮箱（真实存在，所有成员可读）：human / system / board
 */
import type { MailboxKind, MailboxMeta } from "./types.ts";

export const MAIL_SUFFIX = ".swarm";

/** 纯别名：展开成成员清单，本身没有邮箱 */
export const ALIAS_LOCALS = ["all", "agents", "humans", "team", "everyone", "crew", "folks", "pals", "group"] as const;

/** 这些别名都展开成全体成员。实测：模型会自然地猜 team@ —— 猜对一次就省一次退信往返。 */
export const BROADCAST_ALIASES = ["all", "team", "everyone", "crew", "folks", "pals", "group"] as const;

/** 共享邮箱：真实存在，所有成员可读 */
export const SHARED_LOCALS: { local: string; kind: MailboxKind }[] = [
  { local: "human", kind: "human" },
  { local: "system", kind: "system" },
  { local: "board", kind: "board" },
];

export const DEFAULT_HUMANS = ["human"];

/**
 * 保留 local：这些地址永远指向共享邮箱，不能同时充当某个智能体的私人地址。
 * 名字池已排除它们（见 names.ts 的 pickNames），这里是第二道保险。
 * 种子数据里 perfect-pelican 有个叫 "system" 的叙述者 —— 它就落在 system@ 共享邮箱上。
 */
export const RESERVED_LOCALS = ["human", "system", "board"];

const LOCAL_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const SWARM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ParsedAddress {
  ok: true;
  local: string;
  swarmId: string;
  domain: string;
  address: string;
}

export interface AddressError {
  ok: false;
  reason: string;
}

export function domainOf(swarmId: string): string {
  return `${swarmId}${MAIL_SUFFIX}`;
}

export function addressOf(local: string, swarmId: string): string {
  return `${local}@${domainOf(swarmId)}`;
}

/** 取地址的 local 部分（"peliscout@x.swarm" → "peliscout"） */
export function localOf(address: string): string {
  const cut = address.indexOf("@");
  return (cut === -1 ? address : address.slice(0, cut)).trim().toLowerCase();
}

export function isAlias(local: string): boolean {
  return (ALIAS_LOCALS as readonly string[]).includes(local);
}

export function isSharedLocal(local: string): boolean {
  return SHARED_LOCALS.some((item) => item.local === local);
}

/**
 * 解析地址。没写 @域 时用 defaultSwarmId 补齐（同域内的简写）。
 * 域名必须严格等于 <swarmId>.swarm，否则视为非法 —— 这是域隔离的落点。
 */
export function parseAddress(raw: unknown, defaultSwarmId?: string): ParsedAddress | AddressError {
  if (typeof raw !== "string") return { ok: false, reason: "地址必须是字符串" };
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return { ok: false, reason: "地址为空" };

  const parts = text.split("@");
  if (parts.length > 2) return { ok: false, reason: `地址含多个 @：${raw}` };
  const [local, domain] = parts;
  if (!LOCAL_PATTERN.test(local)) return { ok: false, reason: `local 部分非法：${local}` };

  let swarmId = defaultSwarmId ?? "";
  if (parts.length === 2) {
    if (!domain.endsWith(MAIL_SUFFIX)) return { ok: false, reason: `域必须形如 <swarmId>${MAIL_SUFFIX}：${domain}` };
    swarmId = domain.slice(0, -MAIL_SUFFIX.length);
  }
  if (!SWARM_ID_PATTERN.test(swarmId)) return { ok: false, reason: `集群 id 非法或缺失：${swarmId || "(空)"}` };

  return { ok: true, local, swarmId, domain: domainOf(swarmId), address: addressOf(local, swarmId) };
}

/** 同域内显示时省略域名（界面上就显示成 peliscout） */
export function formatAddress(address: string, contextSwarmId?: string): string {
  if (!contextSwarmId) return address;
  const suffix = `@${domainOf(contextSwarmId)}`;
  return address.endsWith(suffix) ? address.slice(0, -suffix.length) : address;
}

/** 一份集群成员名单 —— 展开通配地址只需要它 */
export interface SwarmRoster {
  swarmId: string;
  agents: string[];
  humans?: string[];
}

function descriptor(
  swarmId: string,
  local: string,
  owner: string,
  kind: MailboxKind,
  shared: boolean,
  createdAt: string,
): MailboxMeta {
  return { address: addressOf(local, swarmId), local, swarmId, owner, kind, shared, createdAt };
}

/** 一个集群应当拥有的全部邮箱：每个 agent 一个 + human + system + board */
export function mailboxesFor(roster: SwarmRoster, createdAt: string): MailboxMeta[] {
  const humans = roster.humans ?? DEFAULT_HUMANS;
  // 保留字不开个人邮箱（否则会覆盖共享邮箱）
  const specs: MailboxMeta[] = roster.agents
    .filter((name) => !RESERVED_LOCALS.includes(name))
    .map((name) => descriptor(roster.swarmId, name, name, "agent", false, createdAt));
  for (const human of humans) specs.push(descriptor(roster.swarmId, human, human, "human", true, createdAt));
  for (const shared of SHARED_LOCALS) {
    if (shared.kind === "human") continue; // human 上面已按 humans 列表建过
    specs.push(descriptor(roster.swarmId, shared.local, shared.local, shared.kind, true, createdAt));
  }
  return specs;
}

export interface ExpandedRecipients {
  delivered: string[];
  bounced: { address: string; reason: string }[];
}

/**
 * 收件人展开：别名展开成成员地址，去重；非法/不存在/跨域 → 退信。
 * 纯函数，投递与否由此决定，调用方负责发 mail.sent / mail.bounced。
 */
export function expandRecipients(raws: unknown[], roster: SwarmRoster): ExpandedRecipients {
  const humans = roster.humans ?? DEFAULT_HUMANS;
  const delivered = new Set<string>();
  const bounced: { address: string; reason: string }[] = [];
  /* 保留字不是"人"：名册里若有个叫 system 的成员，它的地址就是共享 system 邮箱，
     不应该被 all@ 当成个人展开（否则共享邮箱会被广播塞满）。 */
  const agents = roster.agents.filter((name) => !RESERVED_LOCALS.includes(name));
  const agentAddresses = agents.map((name) => addressOf(name, roster.swarmId));
  const humanAddresses = humans.map((name) => addressOf(name, roster.swarmId));

  for (const raw of raws) {
    const parsed = parseAddress(raw, roster.swarmId);
    if (!parsed.ok) {
      /* 抢救：真跑里模型常把域名写成占位符（ada@<集群>.swarm）或漏域名 ——
         local 能对上本集群的人/别名/共享邮箱就按同域投递，救不回来才退信。 */
      const rawText = typeof raw === "string" ? raw : String(raw);
      const salvage = rawText.split("@")[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
      const salvageAlias = (BROADCAST_ALIASES as readonly string[]).includes(salvage);
      if (LOCAL_PATTERN.test(salvage) && (salvageAlias || agents.includes(salvage) || humans.includes(salvage) || isSharedLocal(salvage))) {
        if (salvageAlias) for (const item of [...agentAddresses, ...humanAddresses]) delivered.add(item);
        else delivered.add(addressOf(salvage, roster.swarmId));
        continue;
      }
      bounced.push({ address: rawText, reason: parsed.reason + "（本集群地址：" + [...agents, ...humans].join("、") + "）" });
      continue;
    }
    if (parsed.swarmId !== roster.swarmId) {
      bounced.push({ address: parsed.address, reason: `跨域投递暂不支持（本域 ${domainOf(roster.swarmId)}）` });
      continue;
    }
    const { local, address } = parsed;

    if ((BROADCAST_ALIASES as readonly string[]).includes(local)) {
      for (const item of [...agentAddresses, ...humanAddresses]) delivered.add(item);
      continue;
    }
    if (local === "agents") {
      for (const item of agentAddresses) delivered.add(item);
      continue;
    }
    if (local === "humans") {
      for (const item of humanAddresses) delivered.add(item);
      continue;
    }
    if (isSharedLocal(local)) {
      delivered.add(address);
      continue;
    }
    if (!agents.includes(local) && !humans.includes(local)) {
      bounced.push({
        address,
        reason:
          `收件人不存在：${local} 不在本集群名单。` +
          `本集群地址：${[...agents, ...humans].join("、")}；` +
          `群发用 ${BROADCAST_ALIASES.slice(0, 2).map((a) => a + "@" + domainOf(roster.swarmId)).join(" 或 ")}`,
      });
      continue;
    }
    delivered.add(address);
  }

  return { delivered: [...delivered], bounced };
}
