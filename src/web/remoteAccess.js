import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import QRCode from "qrcode";
import { resolveRuntimeConfig } from "../runtimeConfig.js";
import {
  clearAllSavedMobileSessions,
  clearExpiredMobileSessions,
  clearSavedMobileSessionByHash,
  clearSavedMobileSessionById,
  getSavedMobileSession,
  getSavedMobileSessions,
  setSavedMobileSession,
} from "../db.js";

const PAIR_TTL_MS = 5 * 60_000;
const MAX_ACTIVE_PAIRINGS = 5;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const ROTATE_SESSION_MS = 3 * 60 * 60_000;
const SESSION_IDLE_MAX_MS = 5 * 60 * 1000;
const PAIR_FAIL_WINDOW_MS = 60_000;
const PAIR_FAIL_LIMIT = 15;
const COOKIE = "discordbot_mobile_session";
const SESSION_FILE = new URL("../../data/mobile-sessions.json", import.meta.url);

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const token = () => randomBytes(32).toString("base64url");

function cookieValue(req) {
  for (const item of (req.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.hash) return null;

  const createdAt = Number(raw.createdAt ?? raw.created_at ?? Date.now());
  const lastSeenAt = Number(raw.lastSeenAt ?? raw.last_seen_at ?? createdAt);
  const expiresAt = Number(raw.expiresAt ?? raw.expires_at ?? Date.now());
  if (!Number.isFinite(createdAt) || !Number.isFinite(lastSeenAt) || !Number.isFinite(expiresAt)) return null;

  return {
    hash: String(raw.hash),
    id: String(raw.id ?? ""),
    name: String(raw.name ?? "Устройство"),
    userAgent: String(raw.userAgent ?? raw.user_agent ?? "Неизвестное устройство").slice(0, 240),
    ip: raw.ip ?? null,
    createdAt,
    lastSeenAt,
    expiresAt,
    lastRotatedAt: Number(raw.lastRotatedAt ?? raw.last_rotated_at ?? createdAt),
    lastIpPrefix: String(raw.lastIpPrefix ?? raw.last_ip_prefix ?? (raw.ip ?? "").split(".").slice(0, 3).join(".")),
    createdIpPrefix: String(raw.createdIpPrefix ?? raw.created_ip_prefix ?? (raw.ip ?? "").split(".").slice(0, 3).join(".")),
  };
}

function sessionToFileRecord(session) {
  return {
    hash: session.hash,
    id: session.id,
    name: session.name,
    userAgent: session.userAgent,
    ip: session.ip,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    lastRotatedAt: session.lastRotatedAt,
    lastIpPrefix: session.lastIpPrefix ?? null,
    createdIpPrefix: session.createdIpPrefix ?? null,
  };
}

function ipFromRequest(req) {
  if (isLocalRequest(req)) return new URL(req.url).hostname;

  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.split(",")[0].trim();
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return new URL(req.url).hostname;
}

function prefixIp(ip) {
  return String(ip || "").split(".").slice(0, 3).join(".");
}

export function isLocalRequest(req) {
  const host = new URL(req.url).hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export class RemoteAccess {
  constructor({
    port,
    tunnelFactory,
    sessionFile = SESSION_FILE,
    deploymentMode,
    remoteProvider,
    publicBaseUrl,
  } = {}) {
    const runtime = resolveRuntimeConfig(process.env, { deploymentMode, remoteProvider, publicBaseUrl });
    this.port = Number(port) || 8787;
    this.tunnelFactory = tunnelFactory;
    this.sessionFile = sessionFile;
    this.deploymentMode = runtime.deploymentMode;
    this.remoteProvider = runtime.remoteProvider;
    this.publicBaseUrl = runtime.publicBaseUrl;
    this.listener = null;
    this.publicUrl = null;
    this.pairings = new Map();
    this.sessions = new Map();
    this.startPromise = null;
    this.pairFailures = new Map();
    this.loadSessions();
  }

  normalizeSessionFilePath() {
    if (!this.sessionFile) return null;
    return this.sessionFile instanceof URL
      ? this.sessionFile.pathname.replace(/^\/([A-Za-z]:)/, "$1")
      : this.sessionFile;
  }

  loadSessionsFromDisk() {
    const path = this.normalizeSessionFilePath();
    if (!path || !existsSync(path)) return;
    try {
      const stored = JSON.parse(readFileSync(path, "utf8"));
      const sessions = Array.isArray(stored?.sessions) ? stored.sessions : [];
      for (const session of sessions) {
        const normalized = normalizeSession(session);
        if (!normalized || normalized.expiresAt <= Date.now()) continue;
        this.sessions.set(normalized.hash, normalized);
      }
    } catch (err) {
      console.warn("[mobile] Не удалось загрузить сохранённые сессии:", err.message);
    }
  }

  loadSessionsFromDb() {
    clearExpiredMobileSessions();
    for (const row of getSavedMobileSessions()) {
      const normalized = normalizeSession(row);
      if (!normalized) continue;
      this.sessions.set(normalized.hash, normalized);
    }
  }

  loadSessions() {
    this.loadSessionsFromDb();
    if (!this.sessions.size && this.sessionFile) {
      this.loadSessionsFromDisk();
      for (const session of this.sessions.values()) {
        setSavedMobileSession(session);
      }
    }
  }

  persistSessions() {
    for (const session of this.sessions.values()) setSavedMobileSession(session);
    if (!this.sessionFile) return;

    const path = this.normalizeSessionFilePath();
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, sessions: [...this.sessions.values()].map(sessionToFileRecord) }, null, 2));
      renameSync(tmp, path);
    } catch (err) {
      console.warn("[mobile] Не удалось сохранить сессии:", err.message);
    }
  }

  cleanupPairings() {
    const now = Date.now();
    let changed = false;
    for (const [key, expiresAt] of this.pairings) {
      if (expiresAt <= now) {
        this.pairings.delete(key);
        changed = true;
      }
    }
    if (changed) this.pairings = new Map([...this.pairings]);
  }

  cleanupSessions() {
    const now = Date.now();
    let changed = false;
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(key);
        clearSavedMobileSessionByHash(key);
        changed = true;
      }
    }
    if (changed) clearExpiredMobileSessions(now);
    if (changed) this.persistSessions();
  }

  cleanup() {
    this.cleanupPairings();
    this.cleanupSessions();
  }

  isAuthenticated(req) {
    this.cleanup();
    const value = cookieValue(req);
    if (!value) return false;
    let sessionTokenHash = hash(value);
    let session = this.sessions.get(sessionTokenHash);
    if (!session) {
      session = getSavedMobileSession(sessionTokenHash);
      if (session) {
        session = normalizeSession(session);
        if (session) this.sessions.set(session.hash, session);
      }
    }
    if (!session || session.expiresAt <= Date.now()) {
      if (session?.hash) {
        this.sessions.delete(session.hash);
        clearSavedMobileSessionByHash(session.hash);
      }
      return false;
    }

    const now = Date.now();
    const remoteIp = ipFromRequest(req);
    const ipPrefix = prefixIp(remoteIp);
    const ua = req?.headers.get("user-agent") ?? "Неизвестное устройство";
    const suspiciousIp = session.ip && remoteIp && session.ip !== remoteIp;
    const suspiciousPrefix = session.lastIpPrefix && ipPrefix && session.lastIpPrefix !== ipPrefix;
    const suspiciousUa = session.userAgent !== ua;
    const isExpiredByIdle = now - (session.lastSeenAt || 0) > SESSION_IDLE_MAX_MS;

    if (suspiciousIp || suspiciousPrefix || suspiciousUa || isExpiredByIdle) {
      this.sessions.delete(session.hash);
      clearSavedMobileSessionByHash(session.hash);
      return false;
    }

    if ((session.lastSeenAt ? now - session.lastSeenAt : 0) > 30_000) {
      session.lastSeenAt = now;
      session.lastIpPrefix = ipPrefix || session.lastIpPrefix;
      session.userAgent = ua;
      setSavedMobileSession(session);
    }

    let rotateCookie = null;
    if (now - (session.lastRotatedAt || 0) >= ROTATE_SESSION_MS) {
      session.lastRotatedAt = now;
      const nextToken = token();
      const nextHash = hash(nextToken);
      this.sessions.delete(session.hash);
      delete session.hash;
      session.hash = nextHash;
      this.sessions.set(nextHash, session);
      setSavedMobileSession(session);
      clearSavedMobileSessionByHash(sessionTokenHash);
      rotateCookie = nextToken;
      sessionTokenHash = nextHash;
    }

    return rotateCookie ? { session, rotateCookie } : session;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.listener && this.publicUrl) return this.issuePairing();
    if (this.remoteProvider === "disabled") {
      const err = new Error("Удалённый доступ отключён через REMOTE_ACCESS_PROVIDER=disabled.");
      err.status = 400;
      throw err;
    }
    if (this.remoteProvider === "cloudflare") {
      this.publicUrl = this.publicBaseUrl;
      return this.issuePairing();
    }
    if (!process.env.NGROK_AUTHTOKEN) {
      const err = new Error("NGROK_AUTHTOKEN не задан. Добавьте токен ngrok в .env и перезапустите Docker.");
      err.status = 400;
      throw err;
    }
    this.startPromise = (async () => {
      const factory = this.tunnelFactory ?? (async (options) => {
        const ngrok = await import("@ngrok/ngrok");
        return ngrok.forward(options);
      });
      const options = { addr: this.port, authtoken: process.env.NGROK_AUTHTOKEN };
      if (process.env.NGROK_DOMAIN_ID) options.domain_id = process.env.NGROK_DOMAIN_ID;
      else if (process.env.NGROK_DOMAIN) options.domain = process.env.NGROK_DOMAIN;
      this.listener = await factory(options);
      this.publicUrl = this.listener.url();
      return this.issuePairing();
    })();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async issuePairing() {
    const pairToken = token();
    const pairExpiresAt = Date.now() + PAIR_TTL_MS;
    this.pairings.set(hash(pairToken), pairExpiresAt);
    while (this.pairings.size > MAX_ACTIVE_PAIRINGS) {
      this.pairings.delete(this.pairings.keys().next().value);
    }
    const connectUrl = `${this.publicUrl.replace(/\/$/, "")}/connect?token=${encodeURIComponent(pairToken)}`;
    const qrSvg = await QRCode.toString(connectUrl, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
    const devices = this.listSessions();
    return {
      enabled: true,
      publicUrl: this.publicUrl,
      connectUrl,
      pairExpiresAt,
      qrSvg,
      sessions: devices.length,
      devices,
    };
  }

  isPairingValid(pairToken) {
    this.cleanup();
    return Boolean(pairToken && (this.pairings.get(hash(pairToken)) ?? 0) > Date.now());
  }

  exchange(pairToken, req) {
    this.cleanup();
    if (!this.isPairingValid(pairToken)) return null;
    this.pairings.delete(hash(pairToken));

    const sessionToken = token();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const now = Date.now();
    const ua = req?.headers.get("user-agent") ?? "Неизвестное устройство";
    const ip = ipFromRequest(req);
    const ipPrefix = prefixIp(ip);
    const sessionHash = hash(sessionToken);
    const session = {
      id: randomBytes(9).toString("base64url"),
      hash: sessionHash,
      name: describeDevice(ua),
      userAgent: ua.slice(0, 240),
      ip,
      createdIpPrefix: ipPrefix,
      lastIpPrefix: ipPrefix,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      lastRotatedAt: now,
    };
    this.sessions.set(sessionHash, session);
    setSavedMobileSession(session);
    this.persistSessions();
    return { sessionToken, expiresAt };
  }

  listSessions() {
    this.cleanup();
    return [...this.sessions.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(({ hash: _hash, ...session }) => session);
  }

  revokeSession(id) {
    let removed = false;
    for (const [key, session] of this.sessions) {
      if (session.id === id) {
        this.sessions.delete(key);
        clearSavedMobileSessionByHash(key);
        removed = true;
        break;
      }
    }
    if (!removed && id) {
      removed = Boolean(clearSavedMobileSessionById(id));
    }
    if (removed) this.persistSessions();
    return removed;
  }

  revokeAllSessions() {
    const count = this.sessions.size;
    if (count > 0) {
      this.sessions.clear();
      clearAllSavedMobileSessions();
    } else {
      clearAllSavedMobileSessions();
    }
    this.persistSessions();
    return count;
  }

  status() {
    this.cleanup();
    const devices = this.listSessions();
    const pairExpiresAt = this.pairings.size ? Math.max(...this.pairings.values()) : null;
    return {
      enabled: Boolean(this.publicUrl),
      publicUrl: this.publicUrl,
      pairExpiresAt,
      activePairings: this.pairings.size,
      sessions: devices.length,
      devices,
      deploymentMode: this.deploymentMode,
      provider: this.remoteProvider,
      configured: this.remoteProvider === "cloudflare"
        ? Boolean(this.publicBaseUrl)
        : this.remoteProvider === "ngrok" && Boolean(process.env.NGROK_AUTHTOKEN),
    };
  }

  async stop({ revokeSessions = true } = {}) {
    const listener = this.listener;
    this.listener = null;
    this.publicUrl = null;
    this.pairings.clear();
    if (revokeSessions) this.revokeAllSessions();
    if (listener) await listener.close().catch((err) => console.warn("[mobile] Не удалось закрыть ngrok:", err.message));
  }

  sessionCookie(sessionToken, expiresAt) {
    return `${COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}; HttpOnly; Secure; SameSite=Strict`;
  }

  checkPairingRateLimit(req) {
    const remoteIp = ipFromRequest(req);
    const now = Date.now();
    const entry = this.pairFailures.get(remoteIp) || { windowUntil: 0, count: 0 };
    if (entry.windowUntil < now) {
      entry.windowUntil = now + PAIR_FAIL_WINDOW_MS;
      entry.count = 0;
    }
    entry.count += 1;
    this.pairFailures.set(remoteIp, entry);
    if (entry.count > PAIR_FAIL_LIMIT) return false;
    return true;
  }

  resetPairingFailures(req) {
    const remoteIp = ipFromRequest(req);
    this.pairFailures.delete(remoteIp);
  }
}

function describeDevice(userAgent) {
  const os = /Android/i.test(userAgent) ? "Android"
    : /iPhone|iPad/i.test(userAgent) ? "iPhone/iPad"
      : /Windows/i.test(userAgent) ? "Windows"
        : /Macintosh|Mac OS/i.test(userAgent) ? "macOS"
          : /Linux/i.test(userAgent) ? "Linux"
            : "Устройство";
  const browser = /Edg\//i.test(userAgent) ? "Edge"
    : /Firefox\//i.test(userAgent) ? "Firefox"
      : /CriOS|Chrome\//i.test(userAgent) ? "Chrome"
        : /Safari\//i.test(userAgent) ? "Safari"
          : "Браузер";
  return `${browser} · ${os}`;
}
