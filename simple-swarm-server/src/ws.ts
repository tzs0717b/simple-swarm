/*
 * WebSocket 推送中心（M2）。
 *
 * 协议：
 *   客户端 → 服务端  { "sub": "swarm:<id>" }   订阅某个集群
 *                    { "sub": "mailbox:<地址>" } 订阅某个信箱（含投递/已读/归档）
 *                    { "sub": "*" }             全部（新建连接默认）
 *                    { "sub": ..., "replace": true }  先清空既有订阅（智能体只要自己的信箱时用）
 *                    { "since": <seq> }         补拉漏掉的事件
 *                    { "type": "ping" }         心跳
 *   服务端 → 客户端  { "type": "hello", lastSeq }
 *                    { "type": "event", event: SwarmEvent }
 *                    { "type": "catchup", count }
 *                    { "type": "pong" }
 */
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { EventStore } from "./eventstore.ts";
import { expandRecipients } from "./mail.ts";
import { eventSwarmId, type SwarmEvent } from "./types.ts";

export function attachWebSocket(server: Server, store: EventStore): () => void {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Map<WebSocket, Set<string>>();

  const send = (socket: WebSocket, payload: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  };

  wss.on("connection", (socket) => {
    clients.set(socket, new Set(["*"]));
    send(socket, { type: "hello", lastSeq: store.lastSeq, events: store.eventCount });

    socket.on("message", (raw) => {
      let message: { sub?: string; since?: number; type?: string; replace?: boolean };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        return;
      }
      if (typeof message.sub === "string") {
        const subscriptions = clients.get(socket);
        // replace：先清空既有订阅（新建连接默认订阅 "*"）。
        // 智能体只关心自己的信箱时用它，避免收到整个集群的所有事件。
        if (message.replace && subscriptions) subscriptions.clear();
        subscriptions?.add(message.sub);
        send(socket, { type: "subscribed", sub: message.sub, replace: message.replace === true });
      }
      if (typeof message.since === "number") {
        const missed = store.listEvents(message.since);
        send(socket, { type: "catchup", count: missed.length });
        for (const event of missed) send(socket, { type: "event", event });
      }
      if (message.type === "ping") send(socket, { type: "pong", at: Date.now() });
    });

    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  /* 这个事件是否碰到某个信箱（投递给自己 / 自己的已读归档操作） */
  const touchesMailbox = (event: SwarmEvent, address: string): boolean => {
    switch (event.type) {
      case "mail.sent": {
        if (event.mail.from === address) return true;
        const swarm = store.getSwarm(event.mail.swarmId);
        if (!swarm) return false;
        const roster = { swarmId: swarm.id, agents: swarm.agents };
        return expandRecipients([...event.mail.to, ...event.mail.cc], roster).delivered.includes(address);
      }
      case "mail.read":
        return event.reader === address;
      case "mail.moved":
      case "mail.starred":
        return event.owner === address;
      default:
        return false;
    }
  };

  const unsubscribe = store.onAppend((event) => {
    const swarmId = eventSwarmId(event);
    for (const [socket, subscriptions] of clients) {
      let wanted = subscriptions.has("*") || (swarmId !== undefined && subscriptions.has(`swarm:${swarmId}`));

      if (!wanted) {
        for (const sub of subscriptions) {
          if (!sub.startsWith("mailbox:")) continue;
          if (touchesMailbox(event, sub.slice("mailbox:".length))) {
            wanted = true;
            break;
          }
        }
      }

      if (wanted) send(socket, { type: "event", event });
    }
  });

  const heartbeat = setInterval(() => {
    for (const socket of clients.keys()) {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, 30_000);

  console.log("[ws] WebSocket 推送已挂载 /ws");
  return () => {
    clearInterval(heartbeat);
    unsubscribe();
    for (const socket of clients.keys()) socket.terminate();
    wss.close();
  };
}
