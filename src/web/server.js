import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { loadConfig, saveConfig, validateConfig, buildStructure, wipeStructure } from "../structureManager.js";
import { getQueue, peekQueue } from "../music/queue.js";
import { resolveTrack } from "../music/source.js";
import { getHistory, listHistoryChannels, getStats } from "../db.js";

const PUBLIC_DIR = new URL("./public/", import.meta.url);
const PUBLIC_ROOT = PUBLIC_DIR.pathname.replace(/^\/([A-Za-z]:)/, "$1");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}

function notFound() {
  return new Response("Not found", { status: 404 });
}

async function serveStatic(pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const fileUrl = new URL(rel, PUBLIC_DIR);
  const path = fileUrl.pathname.replace(/^\/([A-Za-z]:)/, "$1");
  if (!path.startsWith(PUBLIC_ROOT)) return notFound(); // no path traversal out of public/
  if (!existsSync(path)) return notFound();
  const body = await readFile(path);
  return new Response(body, { headers: { "content-type": MIME[extname(path)] ?? "application/octet-stream" } });
}

function guildSummary(g) {
  return { id: g.id, name: g.name, memberCount: g.memberCount };
}

async function handleConfig(req, parts) {
  const method = req.method;
  if (parts.length === 2 && method === "GET") return json(loadConfig());
  if (parts.length === 2 && method === "PUT") {
    const body = await req.json();
    const errors = validateConfig(body);
    if (errors.length) return json({ errors }, { status: 400 });
    saveConfig(body);
    return json({ ok: true });
  }
  if (parts[2] === "validate" && method === "POST") {
    const body = await req.json();
    return json({ errors: validateConfig(body) });
  }
  return null;
}

async function handleConfigAction(req, parts, client) {
  const action = parts[2]; // build | wipe
  if (!["build", "wipe"].includes(action) || req.method !== "POST") return null;
  const body = await req.json();
  const guild = client.guilds.cache.get(body.guildId);
  if (!guild) return json({ error: "Guild not found" }, { status: 404 });
  const config = loadConfig();
  if (action === "build") {
    const log = await buildStructure(guild, config, { botMemberId: guild.members.me?.id });
    return json({ log });
  }
  if (!body.confirm) return json({ error: "confirm required" }, { status: 400 });
  const log = await wipeStructure(guild, config);
  return json({ log });
}

async function handleMusic(req, parts, client) {
  const guildId = parts[2];
  if (!guildId) return null;
  const action = parts[3];

  if (req.method === "GET" && !action) {
    const queue = peekQueue(guildId);
    return json(queue ? { playing: queue.playing, tracks: queue.tracks, volume: queue.volume } : { playing: null, tracks: [], volume: 1 });
  }
  if (req.method !== "POST" || !action) return null;

  if (action === "play") {
    const { query, channelId } = await req.json();
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return json({ error: "Guild not found" }, { status: 404 });
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased?.()) return json({ error: "Голосовой канал не найден" }, { status: 404 });

    let track;
    try {
      track = await resolveTrack(query, "веб-панель");
    } catch (err) {
      return json({ error: `Не удалось найти трек: ${err.message}` }, { status: 400 });
    }
    if (!track) return json({ error: "Ничего не найдено" }, { status: 404 });

    const queue = getQueue(guildId);
    queue.connect(channel);
    await queue.enqueue(track);
    return json({ ok: true, track });
  }

  const queue = peekQueue(guildId);
  if (!queue) return json({ error: "У этого сервера сейчас нет активной очереди" }, { status: 404 });

  if (action === "skip") queue.skip();
  else if (action === "stop") queue.destroy();
  else if (action === "pause") queue.pause();
  else if (action === "resume") queue.resume();
  else if (action === "volume") {
    const { level } = await req.json();
    queue.setVolume(Math.max(0, Math.min(2, Number(level) / 100)));
  } else return null;
  return json({ ok: true });
}

const MODERATION_ROLES = { muted: "Muted", jailed: "Заключеный" };

async function handleModeration(req, parts, client) {
  const guildId = parts[2];
  const kind = parts[3];
  if (!guildId || !kind) return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return json({ error: "Guild not found" }, { status: 404 });

  if (req.method === "GET" && MODERATION_ROLES[kind]) {
    const role = guild.roles.cache.find((r) => r.name === MODERATION_ROLES[kind]);
    if (!role) return json([]);
    await guild.members.fetch().catch(() => {});
    return json(role.members.map((m) => ({ id: m.id, tag: m.user.tag })));
  }

  if (req.method === "POST" && ["mute", "unmute", "jail", "unjail"].includes(kind)) {
    const roleName = kind.endsWith("mute") ? "Muted" : "Заключеный";
    const role = guild.roles.cache.find((r) => r.name === roleName);
    if (!role) return json({ error: `Роль "${roleName}" не найдена` }, { status: 404 });
    const { userId, reason } = await req.json();
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return json({ error: "Участник не найден (проверь ID)" }, { status: 404 });
    try {
      if (kind.startsWith("un")) await member.roles.remove(role, reason || "Через веб-панель");
      else await member.roles.add(role, reason || "Через веб-панель");
    } catch (err) {
      const hint =
        err.code === 50013
          ? ` Похоже, роль "${roleName}" стоит в иерархии выше роли бота — подними роль бота выше в Server Settings → Roles.`
          : "";
      return json({ error: `Не удалось изменить роль: ${err.message}.${hint}` }, { status: 403 });
    }
    return json({ ok: true });
  }

  return null;
}

async function handleVoice(req, parts, client) {
  const guildId = parts[2];
  if (!guildId) return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return json({ error: "Guild not found" }, { status: 404 });

  if (req.method === "GET") {
    const channelId = parts[3];
    if (!channelId) return null;
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased?.()) return json({ error: "Голосовой канал не найден" }, { status: 404 });
    const members = [...channel.members.values()].map((m) => ({
      id: m.id,
      tag: m.user.tag,
      serverMute: m.voice.serverMute,
      serverDeaf: m.voice.serverDeaf,
      selfMute: m.voice.selfMute,
    }));
    return json(members);
  }

  if (req.method === "POST") {
    const userId = parts[3];
    const action = parts[4];
    if (!userId || !action) return null;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return json({ error: "Участник не найден" }, { status: 404 });

    if (action === "mute" || action === "unmute") {
      if (!member.voice.channelId) return json({ error: "Участник сейчас не в голосовом канале" }, { status: 400 });
      try {
        await member.voice.setMute(action === "mute", "Через веб-панель");
      } catch (err) {
        return json({ error: `Не удалось изменить мьют: ${err.message}` }, { status: 403 });
      }
      return json({ ok: true });
    }

    if (action === "ban") {
      const { reason } = await req.json().catch(() => ({}));
      try {
        await member.ban({ reason: reason || "Через веб-панель" });
      } catch (err) {
        return json({ error: `Не удалось забанить: ${err.message}` }, { status: 403 });
      }
      return json({ ok: true });
    }
  }

  return null;
}

async function handleGuildInfo(req, parts, client) {
  const guildId = parts[2];
  const sub = parts[3];
  if (!guildId || req.method !== "GET") return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return json({ error: "Guild not found" }, { status: 404 });

  if (sub === "voice-channels") {
    return json(guild.channels.cache.filter((c) => c.isVoiceBased?.()).map((c) => ({ id: c.id, name: c.name })));
  }

  if (sub === "members") {
    await guild.members.fetch().catch(() => {});
    const members = guild.members.cache
      .filter((m) => !m.user.bot)
      .map((m) => ({
        id: m.id,
        tag: m.user.tag,
        status: m.presence?.status ?? "offline",
        roles: m.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.name),
      }));
    return json(members);
  }

  return null;
}

async function handleHistory(req, url, parts) {
  const sub = parts[2]; // "channels" | "messages"
  const guildId = url.searchParams.get("guildId");
  if (!guildId) return json({ error: "guildId required" }, { status: 400 });
  if (sub === "channels") return json(listHistoryChannels(guildId));
  if (sub === "messages") {
    const channelId = url.searchParams.get("channelId") || undefined;
    const limit = url.searchParams.get("limit") || 50;
    return json(getHistory({ guildId, channelId, limit }));
  }
  return null;
}

async function handleStats(req, parts) {
  const guildId = parts[2];
  if (!guildId || req.method !== "GET") return null;
  return json(getStats(guildId));
}

async function handleApi(req, url, client) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "resource", ...]
  const resource = parts[1];

  let res = null;
  if (resource === "status" && req.method === "GET") {
    res = json({ tag: client.user?.tag ?? null, uptimeSec: Math.floor(process.uptime()), guilds: client.guilds.cache.map(guildSummary) });
  } else if (resource === "config") {
    res = (await handleConfig(req, parts)) ?? (await handleConfigAction(req, parts, client));
  } else if (resource === "music") {
    res = await handleMusic(req, parts, client);
  } else if (resource === "voice") {
    res = await handleVoice(req, parts, client);
  } else if (resource === "moderation") {
    res = await handleModeration(req, parts, client);
  } else if (resource === "guilds") {
    res = await handleGuildInfo(req, parts, client);
  } else if (resource === "stats") {
    res = await handleStats(req, parts);
  } else if (resource === "history") {
    res = await handleHistory(req, url, parts);
  }
  return res ?? notFound();
}

export function startWebServer(client, port = 8787) {
  const server = Bun.serve({
    // Binds all interfaces inside the container so Docker's published port can
    // reach it — the "localhost-only" security intent is instead enforced by
    // docker-compose.yml publishing the port as 127.0.0.1:PORT:PORT.
    hostname: "0.0.0.0",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/health") {
          return json({ status: "ok", uptime: Math.floor(process.uptime()), bot: client.user?.tag ?? "offline" });
        }
        if (url.pathname.startsWith("/api/")) return await handleApi(req, url, client);
        return await serveStatic(url.pathname);
      } catch (err) {
        console.error("[web] Ошибка запроса:", err);
        return json({ error: err.message }, { status: 500 });
      }
    },
  });
  console.log(`[web] Панель управления: http://127.0.0.1:${server.port}`);
  return server;
}
