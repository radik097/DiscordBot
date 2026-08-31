import { readFile } from "node:fs/promises";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { extname, resolve as resolvePath, sep } from "node:path";
import { Readable } from "node:stream";
import { loadConfig, saveConfig, validateConfig, buildStructure, wipeStructure, rebuildStructure } from "../structureManager.js";
import { getQueue, peekQueue, volumePercentToRatio } from "../music/queue.js";
import { resolveInput } from "../music/source.js";
import { getCachedMusicHistoryTrack, listCachedMusicHistory } from "../music/history.js";
import {
  getPlaylistSaveStatus,
  getSavedPlaylist,
  listSavedPlaylists,
  savePlaylistPlaybackState,
  clearPlaylistPlaybackState,
  startPlaylistSave,
} from "../music/library.js";
import {
  archiveExpiredHistory,
  getHistory,
  listHistoryChannels,
  getStats,
  logAuditAction,
} from "../db.js";
import { RemoteAccess, isLocalRequest } from "./remoteAccess.js";
import { registerRemoteAccess, unregisterRemoteAccess } from "./remoteAccessRegistry.js";
import { AccessControl, verifyTrustedIdentity } from "./accessControl.js";
import { registerAccessControl, unregisterAccessControl } from "./accessControlRegistry.js";
import { downloadService } from "../downloads/service.js";
import { getPreparedMusicMonitor, prepareMusicMonitorTrack, startMusicMonitor } from "../music/monitor.js";

const PUBLIC_DIR = new URL("./public/", import.meta.url);
const PUBLIC_ROOT = resolvePath(PUBLIC_DIR.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_PAIR_BODY_BYTES = 4096;
const PANEL_SESSION_COOKIE = "discordbot_panel_session";
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MUTATE_MAX = 120;
const RATE_LIMIT_PAIR_MAX = 15;
const RATE_LIMIT_LOGIN_MAX = 10;
const INVITE_FORM_PROOF_TTL_MS = 15 * 60_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const panelSessions = new Map();
const rateLimiterStore = new Map();
const remoteRole = "admin";
const localRole = "admin";
const roleByRoute = [
  { path: ["/api/config", "/api/config/build", "/api/config/wipe", "/api/config/rebuild"], method: "POST", roles: ["admin"] },
  { path: ["/api/moderation"], method: "POST", roles: ["admin"] },
  { path: ["/api/music", "/api/voice", "/api/remote-access"], method: "POST", roles: ["admin"] },
  { path: ["/api/downloads"], method: "POST", roles: ["admin"] },
  { path: ["/api/music"], method: "DELETE", roles: ["admin"] },
];

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}

function notFound() {
  return new Response("Not found", { status: 404 });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function rateLimit(key, limit, windowMs = RATE_LIMIT_WINDOW) {
  const now = Date.now();
  const state = rateLimiterStore.get(key) || { windowUntil: 0, count: 0 };
  if (state.windowUntil <= now) {
    state.windowUntil = now + windowMs;
    state.count = 0;
  }
  state.count += 1;
  rateLimiterStore.set(key, state);
  return state.count <= limit;
}

function randomToken() {
  return randomBytes(24).toString("base64url");
}

function parseCookies(req) {
  const header = req.headers.get("cookie") ?? "";
  const out = new Map();
  for (const chunk of header.split(";")) {
    const [name, ...value] = chunk.trim().split("=");
    if (!name) continue;
    out.set(name, decodeURIComponent(value.join("=")));
  }
  return out;
}

function getClientIp(req) {
  const remoteIp = req.headers.get("x-real-ip");
  if (remoteIp) return remoteIp.split(",")[0].trim();
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  if (isLocalRequest(req)) {
    return new URL(req.url).hostname || "localhost";
  }
  const forwardedFor = req.headers.get("x-forwarded-for");
  return forwardedFor ? forwardedFor.split(",")[0].trim() : (new URL(req.url).hostname || "unknown");
}

function isMutationRequest(req) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
}

function isUnsafeMethod(method) {
  return ["POST", "PUT", "DELETE", "PATCH"].includes(method);
}

function ensurePanelSessionCookie(req, headers, remote = false) {
  const cookies = parseCookies(req);
  const existing = cookies.get(PANEL_SESSION_COOKIE);
  if (existing && panelSessions.has(existing)) return existing;

  const token = randomToken();
  const csrf = randomToken();
  panelSessions.set(token, { csrf, roles: [remote ? remoteRole : localRole], createdAt: Date.now(), lastSeenAt: Date.now() });
  const sameSite = "Lax";
  const secure = !isLocalRequest(req) ? "; Secure" : "";
  headers.set(
    "set-cookie",
    `${PANEL_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}${secure}; Max-Age=${Math.floor(30 * 24 * 60 * 60)}`
  );
  return token;
}

function getPanelSession(req) {
  const id = parseCookies(req).get(PANEL_SESSION_COOKIE);
  if (!id) return null;
  const session = panelSessions.get(id);
  if (!session) return null;
  session.lastSeenAt = Date.now();
  return { id, ...session };
}

function requireCsrf(req, session) {
  const headerToken = req.headers.get("x-csrf-token");
  if (!headerToken || !session?.csrf || headerToken !== session.csrf) {
    return false;
  }
  return true;
}

function hasRole(context, roles) {
  if (!context || !context.roles?.length) return false;
  return roles.some((role) => context.roles.includes(role));
}

function matchRbac(method, pathname, context) {
  if (!method || method === "GET" || method === "HEAD") return true;
  for (const rule of roleByRoute) {
    if (rule.method !== method) continue;
    if (!rule.path.some((prefix) => pathname.startsWith(prefix))) continue;
    if (!hasRole(context, rule.roles)) return false;
    return true;
  }
  return hasRole(context, ["admin"]);
}

function notAllowed(message) {
  return json({ error: message }, { status: 403 });
}

function buildSecurityHeaders(headers = {}) {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none';",
    "referrer-policy": "no-referrer",
    ...headers,
  };
}

function enforceMutationSecurity(req, context, pathname, headers, access) {
  if (!isUnsafeMethod(req.method)) return null;
  if (!context) return json({ error: "Требуется авторизация" }, { status: 401, headers: Object.fromEntries(headers) });
  if (!matchRbac(req.method, pathname, context)) return notAllowed("Недостаточно прав");
  if (!requireCsrf(req, context)) return json({ error: "CSRF-токен отсутствует или недействителен" }, { status: 403, headers: Object.fromEntries(headers) });
  if (!withRateLimitForMutate(req, context)) return json({ error: "Превышен лимит mutating-запросов" }, { status: 429, headers: Object.fromEntries(headers) });
  if (pathname === "/api/access/logout") return null;
  if (access && context.accessSession) {
    const decision = access.authorizeMutation(context.accessSession);
    if (!decision.allowed) {
      if (decision.retryAfterMs) headers.set("retry-after", String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
      return json({ error: decision.reason, retryAfterMs: decision.retryAfterMs ?? null }, { status: decision.status || 403, headers: Object.fromEntries(headers) });
    }
  } else if (access && context.kind === "owner") {
    access.noteOwnerMutation();
  } else if (access && context.kind === "legacy-remote") {
    const decision = access.authorizeMutation({ kind: "day" });
    if (!decision.allowed) return json({ error: decision.reason, retryAfterMs: decision.retryAfterMs ?? null }, { status: decision.status || 403, headers: Object.fromEntries(headers) });
  }
  return null;
}

function canonicalStaticPath(pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const candidate = resolvePath(PUBLIC_ROOT, decoded);
  if (!candidate.startsWith(PUBLIC_ROOT + sep) && candidate !== PUBLIC_ROOT && !candidate.startsWith(PUBLIC_ROOT)) return null;
  return candidate;
}

function clientFingerprint(req) {
  if (isLocalRequest(req)) return getClientIp(req);
  return getClientIp(req);
}

function pairingPage(pairToken, valid = true) {
  const title = valid ? "Подключение устройства" : "Ссылка устарела";
  const content = valid
    ? `<p>Ссылка действительна. Подтвердите подключение этого устройства к панели DiscordBot.</p>
       <form method="post" action="/connect">
         <input type="hidden" name="token" value="${escapeHtml(pairToken)}">
         <button>Подключить устройство</button>
       </form>
       <small>После подтверждения сессия действует 12 часов. Просто открытие ссылки токен не расходует.</small>`
    : `<p>Ссылка уже была использована либо истёк срок действия.</p>
       <small>На ПК откройте «Подключить телефон» и создайте новый QR-код.</small>`;
  return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:20px;background:#0f1117;color:#f4f6fb;font:16px/1.5 system-ui,sans-serif}.card{width:min(100%,430px);padding:26px;border:1px solid #343947;border-radius:20px;background:#1b1f2a;box-shadow:0 18px 50px #0008}h1{margin:0 0 12px;font-size:1.55rem}p{color:#d8dbea}form{margin:22px 0 16px}button{width:100%;min-height:52px;border:0;border-radius:13px;background:#5865f2;color:white;font:700 1rem system-ui;cursor:pointer}small{display:block;color:#aeb4c3}
  </style></head><body><main class="card"><h1>${title}</h1>${content}</main></body></html>`, {
    status: valid ? 200 : 401,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...buildSecurityHeaders(),
    },
  });
}

function accessPage({ title, content, status = 200 }) {
  return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:20px;background:#0f1117;color:#f4f6fb;font:16px/1.5 system-ui,sans-serif}.card{width:min(100%,460px);padding:28px;border:1px solid #343947;border-radius:20px;background:#1b1f2a;box-shadow:0 18px 50px #0008}h1{margin:0 0 12px;font-size:1.55rem}p{color:#d8dbea}form{display:grid;gap:14px;margin-top:22px}label{display:grid;gap:7px;color:#d8dbea}input{width:100%;min-height:48px;border:1px solid #444b5d;border-radius:11px;background:#11141c;color:white;padding:10px 12px;font:inherit}button,.button{display:grid;place-items:center;width:100%;min-height:50px;border:0;border-radius:12px;background:#5865f2;color:white;font:700 1rem system-ui;text-decoration:none;cursor:pointer}.password-toggle{min-height:42px;background:#30364a;font-weight:650}.save-password{display:grid;grid-template-columns:22px 1fr;align-items:center;gap:10px;font-size:.94rem}.save-password input{width:20px;min-height:20px;margin:0;accent-color:#5865f2}.muted{color:#aeb4c3;font-size:.9rem}.error{color:#ff9a9a}
  </style><script src="/access-auth.js" defer></script></head><body><main class="card"><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...buildSecurityHeaders() },
  });
}

function loginPage(error = "") {
  return accessPage({
    title: "Вход в DiscordBot",
    content: `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <p>Постоянные пользователи входят по электронной почте и паролю. Для суточного доступа используйте персональную ссылку из Discord.</p>
      <form method="post" action="/login" data-password-form>
        <label>Электронная почта<input id="loginEmail" name="email" type="email" autocomplete="username" required maxlength="254"></label>
        <label>Пароль<input id="loginPassword" name="password" type="password" autocomplete="current-password" required minlength="12" maxlength="128"></label>
        <button class="password-toggle" type="button" data-password-toggle="loginPassword" data-show-label="Показать пароль" data-hide-label="Скрыть пароль" aria-pressed="false">Показать пароль</button>
        <label class="save-password"><input type="checkbox" data-save-password checked>Сохранить пароль в браузере</label>
        <button type="submit">Войти</button>
      </form>`,
  });
}

function permanentSetupPage(rawToken, email, error = "", identitySecret = "") {
  const formProof = createInviteFormProof(identitySecret, rawToken, email);
  return accessPage({
    title: "Создание постоянного доступа",
    content: `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <p>Почта <strong>${escapeHtml(email)}</strong> подтверждена. Создайте пароль для последующих входов.</p>
      <form method="post" action="/access/invite" data-password-form>
        <input name="token" type="hidden" value="${escapeHtml(rawToken)}">
        <input name="proof" type="hidden" value="${escapeHtml(formProof)}">
        <label>Электронная почта<input id="setupEmail" name="username" type="email" autocomplete="username" readonly value="${escapeHtml(email)}"></label>
        <label>Новый пароль<input id="newPassword" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label>
        <label>Повторите пароль<input id="newPasswordConfirm" name="passwordConfirm" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label>
        <button class="password-toggle" type="button" data-password-toggle="newPassword,newPasswordConfirm" data-show-label="Показать пароли" data-hide-label="Скрыть пароли" aria-pressed="false">Показать пароли</button>
        <label class="save-password"><input type="checkbox" data-save-password checked>Сохранить пароль в браузере</label>
        <button type="submit">Создать доступ</button>
      </form>
      <p class="muted">Аккаунт остаётся действующим, пока владелец его не отзовёт. Отдельная браузерная сессия обновляется входом по паролю.</p>`,
  });
}

function accessDeniedPage(message, status = 403) {
  return accessPage({
    title: status === 401 ? "Требуется подтверждение почты" : "Доступ не выдан",
    content: `<p class="error">${escapeHtml(message)}</p><a class="button" href="/login">Перейти ко входу</a>`,
    status,
  });
}

async function readForm(req, maxBytes = 16 * 1024) {
  const declaredLength = Number(req.headers.get("content-length")) || 0;
  if (declaredLength > maxBytes) return null;
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
  return new URLSearchParams(text);
}

function validSameOrigin(req, publicBaseUrl = "") {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const suppliedOrigin = new URL(origin).origin;
    if (suppliedOrigin === new URL(req.url).origin) return true;
    return Boolean(publicBaseUrl) && suppliedOrigin === new URL(publicBaseUrl).origin;
  } catch {
    return false;
  }
}

function createInviteFormProof(secret, rawToken, email, issuedAt = Date.now()) {
  if (!secret || String(secret).length < 32 || !rawToken || !email) return "";
  const normalizedEmail = String(email).trim().toLowerCase();
  const signature = createHmac("sha256", secret)
    .update(`discordbot-invite-form-v1\n${rawToken}\n${normalizedEmail}\n${issuedAt}`)
    .digest("base64url");
  return `${issuedAt}.${signature}`;
}

function verifyInviteFormProof(secret, rawToken, email, proof, now = Date.now()) {
  const [issuedRaw, suppliedSignature, extra] = String(proof || "").split(".");
  const issuedAt = Number(issuedRaw);
  if (
    extra !== undefined
    || !Number.isFinite(issuedAt)
    || !suppliedSignature
    || issuedAt > now + 60_000
    || now - issuedAt > INVITE_FORM_PROOF_TTL_MS
  ) return false;

  const expectedSignature = createInviteFormProof(secret, rawToken, email, issuedAt).split(".")[1] || "";
  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

async function readPairToken(req) {
  const declaredLength = Number(req.headers.get("content-length")) || 0;
  if (declaredLength > MAX_PAIR_BODY_BYTES) return null;
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PAIR_BODY_BYTES) return null;
  return new URLSearchParams(text).get("token");
}

async function readJson(req) {
  const declaredLength = Number(req.headers.get("content-length")) || 0;
  if (declaredLength > MAX_JSON_BODY_BYTES) {
    const err = new Error("Тело запроса превышает 1 МБ");
    err.status = 413;
    throw err;
  }
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BODY_BYTES) {
    const err = new Error("Тело запроса превышает 1 МБ");
    err.status = 413;
    throw err;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("Некорректный JSON в запросе");
    err.status = 400;
    throw err;
  }
}

async function serveStatic(pathname) {
  const filePath = canonicalStaticPath(pathname);
  if (!filePath) return notFound();
  const body = await readFile(filePath);
  return new Response(body, { headers: { "content-type": MIME[extname(filePath)] ?? "application/octet-stream", ...buildSecurityHeaders() } });
}

function guildSummary(g) {
  return { id: g.id, name: g.name, memberCount: g.memberCount };
}

async function handleConfig(req, parts) {
  const method = req.method;
  if (parts.length === 2 && method === "GET") return json(loadConfig());
  if (parts.length === 2 && method === "PUT") {
    const body = await readJson(req);
    const errors = validateConfig(body);
    if (errors.length) return json({ errors }, { status: 400 });
    saveConfig(body);
    return json({ ok: true });
  }
  if (parts[2] === "validate" && method === "POST") {
    const body = await readJson(req);
    return json({ errors: validateConfig(body) });
  }
  return null;
}

async function handleConfigAction(req, parts, client, auth, mutateHeaders) {
  const action = parts[2]; // build | wipe | rebuild
  if (!["build", "wipe", "rebuild"].includes(action) || req.method !== "POST") return null;
  if (!isMutationRequest(req.method)) return null;
  const body = await readJson(req);
  if (!matchRbac(req.method, `/api/config/${action}`, auth)) return notAllowed("Недостаточно прав");
  const guild = client.guilds.cache.get(body.guildId);
  if (!guild) return json({ error: "Guild not found" }, { status: 404 });

  const config = loadConfig();
  if (body.confirm !== true && (action === "wipe" || action === "rebuild")) {
    return json({ error: "confirm required" }, { status: 400 });
  }

  let log;
  if (action === "build") log = await buildStructure(guild, config, { botMemberId: guild.members.me?.id });
  if (action === "wipe") log = await wipeStructure(guild, config);
  if (action === "rebuild") log = await rebuildStructure(guild, config, { botMemberId: guild.members.me?.id });

  logAuditAction({
    action: `config:${action}`,
    actorSession: auth.sessionId,
    actorGuildId: body.guildId,
    actorIp: getClientIp(req),
    actorUserAgent: req.headers.get("user-agent"),
    resource: `/guilds/${body.guildId}/config/${action}`,
    details: { action, guildId: body.guildId, confirm: body.confirm === true },
  });
  return json({ log });
}

async function handleMusic(req, parts, client, auth, mutateHeaders) {
  const guildId = parts[2];
  if (!guildId) return null;
  const action = parts[3];

  if (req.method === "GET" && !action) {
    const queue = peekQueue(guildId);
    const playlistSave = await getPlaylistSaveStatus(guildId);
    return json(queue
      ? { playing: queue.playing, tracks: queue.tracks, volume: queue.volume, playback: queue.getPlaybackStatus(), playlistSave, activePlaylist: queue.activePlaylist }
      : { playing: null, tracks: [], volume: 1, playback: null, playlistSave, activePlaylist: null });
  }

  if (req.method === "GET" && action === "playlists") {
    const manifestId = parts[4];
    if (!manifestId) return json({ playlists: await listSavedPlaylists(guildId), activePlaylistId: peekQueue(guildId)?.activePlaylist?.id ?? null });
    const playlist = await getSavedPlaylist(guildId, manifestId).catch(() => null);
    if (!playlist) return json({ error: "Сохранённый плейлист не найден" }, { status: 404 });
    return json({ playlist });
  }

  if (req.method === "POST" && action === "monitor" && parts[4] === "prepare") {
    const { query } = await readJson(req);
    if (!String(query ?? "").trim()) return json({ error: "Укажите трек или ссылку для мониторинга" }, { status: 400 });
    let resolved;
    try {
      resolved = await resolveInput(String(query).trim(), "веб-монитор");
    } catch (error) {
      return json({ error: `Не удалось подготовить мониторинг: ${error.message}` }, { status: 400 });
    }
    const track = resolved.tracks?.[0];
    if (!track) return json({ error: "Не найден доступный трек для мониторинга" }, { status: 404 });
    try {
      const prepared = await prepareMusicMonitorTrack({ key: `${guildId}:${auth.sessionId}`, track });
      return json({ ok: true, kind: resolved.kind, ...prepared });
    } catch (error) {
      return json({ error: `Не удалось закэшировать трек для мониторинга: ${error.message}` }, { status: 409 });
    }
  }

  if (req.method === "GET" && action === "monitor") {
    const requestUrl = new URL(req.url);
    const monitorKey = `${guildId}:${auth.sessionId}`;
    const sourceId = requestUrl.searchParams.get("source");
    const queue = peekQueue(guildId);
    const prepared = sourceId ? getPreparedMusicMonitor(monitorKey, sourceId) : null;
    const source = prepared
      ? {
          file: prepared.file,
          offsetSec: 0,
          volume: volumePercentToRatio(requestUrl.searchParams.get("volume")) ?? 1,
        }
      : sourceId
        ? null
        : queue?.getMonitorSource();
    if (!source) return json({ error: "Сейчас нет активного закэшированного трека для мониторинга" }, { status: 409 });
    let monitor;
    try {
      monitor = await startMusicMonitor({
        key: monitorKey,
        ...source,
      });
    } catch (error) {
      return json({ error: `Не удалось запустить мониторинг: ${error.message}` }, { status: 409 });
    }
    req.signal.addEventListener("abort", monitor.stop, { once: true });
    const headers = buildSecurityHeaders({
      "content-type": monitor.contentType,
      "cache-control": "private, no-store, max-age=0",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
    });
    return new Response(Readable.toWeb(monitor.stream), { headers });
  }

  if (req.method === "GET" && action === "history") {
    return json({ tracks: await listCachedMusicHistory(guildId, { limit: 200 }) });
  }

  if (req.method === "POST" && action === "history" && parts[4] && parts[5] === "play") {
    const { channelId } = await readJson(req);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return json({ error: "Guild not found" }, { status: 404 });
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased?.()) return json({ error: "Выберите голосовой канал" }, { status: 404 });
    const track = await getCachedMusicHistoryTrack(guildId, parts[4], "веб-панель");
    if (!track) return json({ error: "Песня больше не находится в кэше" }, { status: 404 });
    const queue = getQueue(guildId);
    queue.connect(channel);
    try {
      await queue.enqueueMany([track]);
    } catch (err) {
      return json({ error: err.message }, { status: 409 });
    }
    logAuditAction({
      action: "music:history-play",
      actorSession: auth.sessionId,
      actorGuildId: guildId,
      actorIp: getClientIp(req),
      actorUserAgent: req.headers.get("user-agent"),
      resource: `/guilds/${guildId}/music/history/${parts[4]}`,
      details: { historyId: Number(parts[4]), cacheFile: track.cacheFile },
    });
    return json({ ok: true, track });
  }

  if (req.method === "POST" && action === "playlists" && parts[4] && parts[5] === "activate") {
    const manifestId = parts[4];
    const { channelId } = await readJson(req);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return json({ error: "Guild not found" }, { status: 404 });
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased?.()) return json({ error: "Выберите голосовой канал" }, { status: 404 });
    const playlist = await getSavedPlaylist(guildId, manifestId).catch(() => null);
    if (!playlist) return json({ error: "Сохранённый плейлист не найден" }, { status: 404 });
    const queue = getQueue(guildId);
    if (queue.activePlaylist?.id === playlist.id) {
      return json({ ok: true, alreadyActive: true, playlist: queue.activePlaylist });
    }
    if (queue.activePlaylist?.id) savePlaylistPlaybackState(guildId, queue.activePlaylist.id, queue.getPlaylistSnapshot());
    const tracks = playlist.playback?.tracks?.length ? playlist.playback.tracks : playlist.tracks;
    if (!tracks.length) return json({ error: "В сохранённом плейлисте нет треков" }, { status: 409 });
    clearPlaylistPlaybackState(guildId, playlist.id);
    queue.connect(channel);
    queue.switchPlaylist(playlist, tracks);
    return json({ ok: true, alreadyActive: false, playlist: queue.activePlaylist, resumed: Boolean(playlist.playback?.tracks?.length), addedCount: tracks.length });
  }

  if (req.method !== "POST" || !action) return null;
  if (action === "play") {
    const { query, channelId } = await readJson(req);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return json({ error: "Guild not found" }, { status: 404 });
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased?.()) return json({ error: "В голосовой канал не найден" }, { status: 404 });

    let resolved;
    try {
      resolved = await resolveInput(query, "веб-панель");
    } catch (err) {
      return json({ error: `Не удалось обработать запрос: ${err.message}` }, { status: 400 });
    }
    if (!resolved.tracks.length) return json({ error: "В плейлисте или поиске нет доступных треков" }, { status: 404 });
    const queue = getQueue(guildId);
    queue.connect(channel);
    try {
      await queue.enqueueMany(resolved.tracks);
    } catch (err) {
      return json({ error: err.message }, { status: 409 });
    }
    logAuditAction({
      action: "music:play",
      actorSession: auth.sessionId,
      actorGuildId: guildId,
      actorIp: getClientIp(req),
      actorUserAgent: req.headers.get("user-agent"),
      resource: `/guilds/${guildId}/music/play`,
      details: { query, count: resolved.tracks.length },
    });
    return json({
      ok: true,
      kind: resolved.kind,
      title: resolved.title,
      addedCount: resolved.tracks.length,
      track: resolved.tracks[0],
    });
  }

  const queue = peekQueue(guildId);
  if (!queue) return json({ error: "У этого сервера сейчас нет активной очереди" }, { status: 404 });

  if (action === "skip") queue.skip();
  else if (action === "stop") queue.destroy();
  else if (action === "pause") queue.pause();
  else if (action === "resume") queue.resume();
  else if (action === "track") {
    const { queueId, operation } = await readJson(req);
    if (!queueId || !["play", "remove"].includes(operation)) {
      return json({ error: "Нужны queueId и operation=play|remove" }, { status: 400 });
    }
    const track = operation === "play"
      ? queue.playTrackNow(queueId)
      : queue.removeTrack(queueId);
    if (!track) return json({ error: "Трек уже исчез из очереди — обновите список" }, { status: 404 });
  } else if (action === "save-playlist") {
    const body = await readJson(req);
    const tracks = queue.getPlaylistSnapshot();
    const job = await startPlaylistSave(guildId, tracks, body.title);
    return json({ ok: true, job }, { status: job.alreadyRunning ? 200 : 202 });
  } else if (action === "volume") {
    const { level } = await readJson(req);
    const ratio = volumePercentToRatio(level);
    if (ratio === null) return json({ error: "Громкость должна быть числом от 0 до 200" }, { status: 400 });
    const appliedVolume = queue.setVolume(ratio);
    return json({ ok: true, volume: appliedVolume });
  } else return null;
  return json({ ok: true });
}

async function handleModeration(req, parts, client, auth, mutateHeaders) {
  const guildId = parts[2];
  const kind = parts[3];
  if (!guildId || !kind) return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return json({ error: "Guild not found" }, { status: 404 });

  if (req.method === "GET" && kind) {
    const role = guild.roles.cache.find((r) => r.name === (kind.endsWith("mute") ? "Muted" : "Заключеный"));
    if (!role) return json([]);
    await guild.members.fetch().catch(() => {});
    return json(role.members.map((m) => ({ id: m.id, tag: m.user.tag })));
  }
  if (req.method === "POST" && ["mute", "unmute", "jail", "unjail"].includes(kind)) {
    const roleName = kind.endsWith("mute") ? "Muted" : "Заключеный";
    const role = guild.roles.cache.find((r) => r.name === roleName);
    if (!role) return json({ error: `Роль "${roleName}" не найдена` }, { status: 404 });
    const { userId, reason } = await readJson(req);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return json({ error: "Участник не найден (проверь ID)" }, { status: 404 });
    try {
      if (kind.startsWith("un")) await member.roles.remove(role, reason || "Через веб-панель");
      else await member.roles.add(role, reason || "Через веб-панель");
      logAuditAction({
        action: `moderation:${kind}`,
        actorSession: auth.sessionId,
        actorGuildId: guildId,
        actorIp: getClientIp(req),
        actorUserAgent: req.headers.get("user-agent"),
        resource: `/guilds/${guildId}/members/${userId}`,
        details: { kind, reason, userId },
      });
      return json({ ok: true });
    } catch (err) {
      const hint =
        err.code === 50013
          ? ` Похоже, роль "${roleName}" стоит в иерархии выше роли бота — подними роль бота выше в Server Settings → Roles.`
          : "";
      return json({ error: `Не удалось изменить роль: ${err.message}.${hint}` }, { status: 403 });
    }
  }
  return null;
}

async function handleVoice(req, parts, client, auth, mutateHeaders) {
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
      logAuditAction({
        action: `voice:${action}`,
        actorSession: auth.sessionId,
        actorGuildId: guildId,
        actorIp: getClientIp(req),
        actorUserAgent: req.headers.get("user-agent"),
        resource: `/guilds/${guildId}/voice/${userId}`,
        details: { action },
      });
      return json({ ok: true });
    }

    if (action === "ban") {
      const { reason } = await readJson(req);
      try {
        await member.ban({ reason: reason || "Через веб-панель" });
      } catch (err) {
        return json({ error: `Не удалось забанить: ${err.message}` }, { status: 403 });
      }
      logAuditAction({
        action: `voice:ban`,
        actorSession: auth.sessionId,
        actorGuildId: guildId,
        actorIp: getClientIp(req),
        actorUserAgent: req.headers.get("user-agent"),
        resource: `/guilds/${guildId}/members/${userId}`,
        details: { reason },
      });
      return json({ ok: true });
    }
  }
  return null;
}

async function handleGuildInfo(req, parts, client, auth) {
  const guildId = parts[2];
  const sub = parts[3];
  if (!guildId || req.method !== "GET") return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return json({ error: "Guild not found" }, { status: 404 });

  if (sub === "voice-channels") return json(guild.channels.cache.filter((c) => c.isVoiceBased?.()).map((c) => ({ id: c.id, name: c.name })));
  if (sub === "members") {
    await guild.members.fetch().catch(() => {});
    return json(guild.members.cache
      .filter((m) => !m.user.bot)
      .map((m) => ({ id: m.id, tag: m.user.tag, status: m.presence?.status ?? "offline", roles: m.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.name) })));
  }
  return null;
}

async function handleHistory(req, url, parts, auth) {
  const sub = parts[2];
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

async function handleStats(req, parts, auth) {
  const guildId = parts[2];
  if (!guildId || req.method !== "GET") return null;
  if (isUnsafeMethod(req.method)) return notAllowed("Только чтение статистики");
  return json(getStats(guildId));
}

async function handleRemoteAccess(req, url, remote) {
  if (!isLocalRequest(req)) return json({ error: "Управление мобильным доступом доступно только локально" }, { status: 403 });
  if (url.pathname === "/api/remote-access") {
    if (req.method === "GET") {
      return json(remote.status(), { headers: buildSecurityHeaders() });
    }
    if (req.method === "POST") {
      return json(await remote.start(), { headers: buildSecurityHeaders() });
    }
    if (req.method === "DELETE") {
      await remote.stop();
      return json({ ok: true }, { headers: buildSecurityHeaders() });
    }
  }
  if (url.pathname === "/api/remote-access/sessions" && req.method === "DELETE") {
    const removed = remote.revokeAllSessions();
    return json({ ok: true, removed }, { headers: buildSecurityHeaders() });
  }
  const sessionMatch = url.pathname.match(/^\/api\/remote-access\/sessions\/([A-Za-z0-9_-]+)$/);
  if (sessionMatch && req.method === "DELETE") {
    return remote.revokeSession(sessionMatch[1]) ? json({ ok: true }, { headers: buildSecurityHeaders() }) : json({ error: "Сессия уже удалена" }, { status: 404, headers: buildSecurityHeaders() });
  }
  if (url.pathname.startsWith("/connect")) return null;
  return notFound();
}

async function handleDownloads(req, url, auth, downloads) {
  if (req.method === "GET") {
    const guildId = url.searchParams.get("guildId") || undefined;
    return json(downloads.status(loadConfig(), guildId));
  }
  if (req.method === "POST") {
    const body = await readJson(req);
    const guildId = String(body.guildId || "").trim();
    if (!guildId) return json({ error: "Выберите Discord-сервер." }, { status: 400 });
    try {
      const queued = downloads.startPublic({
        guildId,
        channelId: null,
        userId: `panel:${auth.sessionId}`,
        userTag: auth.accessSession?.email || "Веб-панель",
        sourceUrl: body.url,
        format: body.format,
        quality: body.quality,
      });
      return json({ ok: true, id: queued.id, status: "queued" }, { status: 202 });
    } catch (error) {
      return json({ error: error.message }, { status: 400 });
    }
  }
  return notAllowed("Разрешены только GET и POST");
}

async function handleAccessApi(req, url, access, context) {
  const headers = buildSecurityHeaders();
  if (url.pathname === "/api/access/me" && req.method === "GET") {
    const session = context?.accessSession;
    return json({
      authenticated: Boolean(session),
      email: session?.email ?? null,
      kind: session?.kind ?? null,
      expiresAt: session?.expiresAt ?? null,
      owner: session?.kind === "owner",
    }, { headers });
  }

  if (url.pathname === "/api/access/logout" && req.method === "POST") {
    access.revokeCurrent(req);
    return json({ ok: true }, { headers: { ...headers, "set-cookie": access.clearCookie(req) } });
  }

  if (!context?.accessSession || context.accessSession.kind !== "owner") {
    return json({ error: "Управление доступом разрешено только владельцу" }, { status: 403, headers });
  }

  if (url.pathname === "/api/access/admin" && req.method === "GET") {
    return json(access.listAdminState(), { headers });
  }

  if (url.pathname === "/api/access/admin/invites" && req.method === "POST") {
    const body = await readJson(req);
    const kind = body.kind === "day" ? "day" : "permanent";
    const invite = access.issueInvite(body.email, kind, `owner:${context.accessSession.email}`);
    return json(invite, { status: 201, headers });
  }

  const sessionMatch = url.pathname.match(/^\/api\/access\/admin\/sessions\/([A-Za-z0-9_-]+)$/);
  if (sessionMatch && req.method === "DELETE") {
    return access.revokeSession(sessionMatch[1])
      ? json({ ok: true }, { headers })
      : json({ error: "Сессия уже завершена" }, { status: 404, headers });
  }

  const accountMatch = url.pathname.match(/^\/api\/access\/admin\/accounts\/([A-Za-z0-9_-]+)$/);
  if (accountMatch && req.method === "DELETE") {
    return access.revokeAccount(accountMatch[1])
      ? json({ ok: true }, { headers })
      : json({ error: "Аккаунт уже отозван" }, { status: 404, headers });
  }

  return notFound();
}

async function handleApi(req, url, client, remote, access, context, downloads) {
  const parts = url.pathname.split("/").filter(Boolean);
  const resource = parts[1];
  const headers = new Headers(buildSecurityHeaders());

  const mutatingGuard = enforceMutationSecurity(req, context, url.pathname, headers, access);
  if (mutatingGuard) return mutatingGuard;

  if (resource === "status" && req.method === "GET") {
    return json({
      ready: client.isReady(),
      tag: client.user?.tag ?? null,
      uptimeSec: Math.floor(process.uptime()),
      guilds: client.guilds.cache.map(guildSummary),
      stagingMode: process.env.ACCESS_STAGING_MODE === "true",
    }, { headers: Object.fromEntries(headers) });
  }
  if (resource === "config") return (await handleConfig(req, parts)) ?? (await handleConfigAction(req, parts, client, context));
  if (resource === "music") return await handleMusic(req, parts, client, context, headers);
  if (resource === "voice") return await handleVoice(req, parts, client, context, headers);
  if (resource === "moderation") return await handleModeration(req, parts, client, context, headers);
  if (resource === "guilds") return await handleGuildInfo(req, parts, client, context);
  if (resource === "stats") return await handleStats(req, parts, context);
  if (resource === "history") return await handleHistory(req, url, parts, context);
  if (resource === "downloads") return await handleDownloads(req, url, context, downloads);
  if (resource === "csrf" && req.method === "GET") {
    if (!context?.csrf) return json({ error: "Требуется авторизация" }, { status: 401, headers: Object.fromEntries(headers) });
    return json({ token: context.csrf }, { headers: Object.fromEntries(headers) });
  }
  if (resource === "remote-access") return await handleRemoteAccess(req, url, remote);
  if (resource === "access") return await handleAccessApi(req, url, access, context);
  return null;
}

function buildContext(req) {
  const cookieSession = getPanelSession(req);
  if (cookieSession) {
    return {
      sessionId: cookieSession.id ?? randomToken(),
      remote: false,
      kind: "owner",
      roles: cookieSession.roles ?? [localRole],
      csrf: cookieSession.csrf,
    };
  }
  return null;
}

function withRateLimitForMutate(req, context) {
  const key = `${context?.sessionId || clientFingerprint(req)}:${new URL(req.url).pathname}`;
  return rateLimit(key, RATE_LIMIT_MUTATE_MAX, RATE_LIMIT_WINDOW);
}

function buildSessionContext(req, remoteAuth, headers, accessSession = null, forceCreate = false, includeRemote = false) {
  if (accessSession) {
    return {
      sessionId: accessSession.id,
      remote: accessSession.kind !== "owner",
      kind: accessSession.kind,
      roles: ["admin"],
      csrf: accessSession.csrf,
      accessSession,
    };
  }
  const existing = buildContext(req);
  if (existing) return existing;
  if (!forceCreate && !isLocalRequest(req) && !includeRemote) return null;

  const roles = [remoteRole];
  const panelSessionId = ensurePanelSessionCookie(req, headers, Boolean(includeRemote));
  const panelSession = panelSessions.get(panelSessionId);
  if (!panelSession) return null;
  if (includeRemote && panelSession.roles?.length === 0) {
    panelSession.roles = roles;
  }
  return {
    sessionId: panelSessionId,
    remote: Boolean(includeRemote),
    kind: includeRemote ? "legacy-remote" : "owner",
    roles: panelSession.roles || [localRole],
    csrf: panelSession.csrf,
  };
}

export function startWebServer(client, port = 8787, {
  accessControl = null,
  identitySecret = process.env.PROJECT_IDENTITY_SECRET || "",
  downloads = downloadService,
} = {}) {
  const remote = new RemoteAccess({ port });
  const access = accessControl || new AccessControl({ publicBaseUrl: process.env.ACCESS_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL });
  registerRemoteAccess(client, remote);
  registerAccessControl(client, access);
  let historyCleanupTimer = null;
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const headers = new Headers(buildSecurityHeaders());
      const local = isLocalRequest(req);
      const trustedIdentity = verifyTrustedIdentity(req, identitySecret);
      let accessSession = access.authenticate(req, { trustedEmail: local ? access.ownerEmail : trustedIdentity?.email });
      const ownerIdentity = local || trustedIdentity?.email === access.ownerEmail;
      const sessionEligiblePath = url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/api/");
      if (!accessSession && ownerIdentity && sessionEligiblePath) {
        const created = access.createOwnerSession(req);
        accessSession = created.session;
        headers.set("set-cookie", access.sessionCookie(created.token, created.session.expiresAt, req));
      }
      if (url.pathname === "/health") {
        return json({
          ready: client.isReady(),
          gatewayReady: client.isReady(),
          guilds: client.isReady() ? client.guilds.cache.size : 0,
          tag: client.user?.tag ?? null,
          startedAt: Date.now(),
          access: { enabled: true, ownerPriorityMs: access.ownerPriorityMs },
        }, { status: client.isReady() ? 200 : 503, headers: Object.fromEntries(headers) });
      }

      const downloadMatch = url.pathname.match(/^\/downloads\/([A-Za-z0-9_-]{40,})\/[^/]+$/);
      if (downloadMatch) {
        if (req.method !== "GET" && req.method !== "HEAD") return notAllowed("Разрешены только GET и HEAD");
        const item = downloads.takePublicFile(downloadMatch[1]);
        if (!item) return new Response("Ссылка истекла или недействительна.", { status: 404, headers });
        const file = Bun.file(item.path);
        if (!(await file.exists())) return new Response("Файл больше недоступен.", { status: 404, headers });
        headers.set("content-type", file.type || "application/octet-stream");
        headers.set("content-length", String(item.size));
        headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(item.filename)}`);
        headers.set("cache-control", "private, no-store, max-age=0");
        headers.set("x-content-type-options", "nosniff");
        return new Response(req.method === "HEAD" ? null : file, { headers });
      }

      const remoteAuth = remote.isAuthenticated(req);
      const context = buildSessionContext(req, remoteAuth, headers, accessSession, local, Boolean(remoteAuth));
      if (context?.rotateCookie) {
        headers.set("set-cookie", remote.sessionCookie(context.rotateCookie, context.expiresAt || Date.now() + 12 * 60 * 60 * 1000));
      }
      if (remoteAuth && typeof remoteAuth === "object" && remoteAuth.rotateCookie && !context.rotateCookie) {
        // compatibility fallback, если сессия пришла из старого формата
        headers.set("set-cookie", remote.sessionCookie(remoteAuth.rotateCookie, remoteAuth.expiresAt || Date.now() + 12 * 60 * 60 * 1000));
      }

      try {
        if (url.pathname === "/access/invite") {
          if (req.method === "GET") {
            const rawToken = url.searchParams.get("token") || "";
            const invite = access.getInvite(rawToken);
            if (!invite) return accessDeniedPage("Ссылка уже использована, отозвана или истекла.", 401);
            if (!trustedIdentity?.email) {
              return accessDeniedPage("Cloudflare не передал подтверждённую почту. Откройте исходную ссылку ещё раз и завершите проверку кода.", 401);
            }
            if (trustedIdentity.email !== invite.email) {
              return accessDeniedPage(`Ссылка выдана для другой электронной почты. Подтверждён адрес ${trustedIdentity.email}.`, 403);
            }
            if (invite.kind === "permanent") return permanentSetupPage(rawToken, invite.email, "", identitySecret);
            const redeemed = access.redeemDayInvite(rawToken, trustedIdentity.email, req);
            if (!redeemed) return accessDeniedPage("Ссылка уже использована либо истекла.", 401);
            return new Response(null, {
              status: 303,
              headers: {
                location: "/",
                "set-cookie": access.sessionCookie(redeemed.token, redeemed.session.expiresAt, req),
                ...buildSecurityHeaders(),
              },
            });
          }
          if (req.method === "POST") {
            const form = await readForm(req);
            if (!form) return accessDeniedPage("Форма слишком большая.", 413);
            const rawToken = form.get("token") || "";
            const invite = access.getInvite(rawToken);
            if (!invite || invite.kind !== "permanent") return accessDeniedPage("Ссылка уже использована либо истекла.", 401);
            const validFormProof = verifyInviteFormProof(identitySecret, rawToken, invite.email, form.get("proof"));
            if (!validFormProof && !validSameOrigin(req, access.publicBaseUrl)) return accessDeniedPage("Запрос отклонён.", 403);
            if (!validFormProof && (!trustedIdentity?.email || trustedIdentity.email !== invite.email)) {
              return accessDeniedPage("Подтверждённая почта не совпадает с адресом приглашения.", 403);
            }
            if (form.get("password") !== form.get("passwordConfirm")) {
              return permanentSetupPage(rawToken, invite.email, "Пароли не совпадают.", identitySecret);
            }
            try {
              const activated = access.completePermanentInvite(rawToken, invite.email, form.get("password"), req);
              if (!activated) return accessDeniedPage("Ссылка уже использована либо истекла.", 401);
              return new Response(null, {
                status: 303,
                headers: {
                  location: "/",
                  "set-cookie": access.sessionCookie(activated.token, activated.session.expiresAt, req),
                  ...buildSecurityHeaders(),
                },
              });
            } catch (error) {
              return permanentSetupPage(rawToken, invite.email, error.message, identitySecret);
            }
          }
          return notFound();
        }

        if (url.pathname === "/login") {
          if (req.method === "GET") {
            if (context) return new Response(null, { status: 303, headers: { location: "/", ...buildSecurityHeaders() } });
            return loginPage();
          }
          if (req.method === "POST") {
            if (!validSameOrigin(req, access.publicBaseUrl)) return loginPage("Запрос отклонён.");
            const form = await readForm(req);
            if (!form) return accessDeniedPage("Форма слишком большая.", 413);
            const email = String(form.get("email") || "").trim().toLowerCase();
            const loginKey = `login:${getClientIp(req)}:${email}`;
            if (!rateLimit(loginKey, RATE_LIMIT_LOGIN_MAX, 15 * 60_000)) return accessPage({ title: "Слишком много попыток", content: "<p class=\"error\">Повторите вход через 15 минут.</p>", status: 429 });
            try {
              const loggedIn = access.login(email, form.get("password"), req);
              if (!loggedIn) return loginPage("Неверная почта или пароль.");
              return new Response(null, {
                status: 303,
                headers: {
                  location: "/",
                  "set-cookie": access.sessionCookie(loggedIn.token, loggedIn.session.expiresAt, req),
                  ...buildSecurityHeaders(),
                },
              });
            } catch {
              return loginPage("Неверная почта или пароль.");
            }
          }
          return notFound();
        }

        if (url.pathname.startsWith("/api")) {
          if (!context && !local && !remoteAuth) return json({ error: "Требуется авторизация" }, { status: 401, headers: Object.fromEntries(headers) });
          const apiResponse = await handleApi(req, url, client, remote, access, context, downloads);
          if (apiResponse) {
            if (apiResponse instanceof Response) {
              const next = new Headers(apiResponse.headers);
              for (const [k, v] of headers.entries()) next.set(k, v);
              return new Response(apiResponse.body, { status: apiResponse.status, headers: next });
            }
            return apiResponse;
          }
          return notFound();
        }

        if (url.pathname === "/connect") {
          if (req.method === "GET") return pairingPage(url.searchParams.get("token") || "", remote.isPairingValid(url.searchParams.get("token") || ""));
          if (req.method === "POST") {
            if (!remote.checkPairingRateLimit(req)) return json({ error: "Превышен лимит неуспешных pairing-запросов" }, { status: 429 });
            const pairToken = await readPairToken(req);
            const session = remote.exchange(pairToken, req);
            remote.resetPairingFailures(req);
            if (!session) return pairingPage("", false);
            return new Response(null, {
              status: 303,
              headers: {
                location: "/",
                "set-cookie": remote.sessionCookie(session.sessionToken, session.expiresAt),
                ...buildSecurityHeaders(),
              },
            });
          }
          return notFound();
        }

        const staticResponse = await serveStatic(url.pathname);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          if (!context && !local && !remoteAuth) return new Response(null, { status: 303, headers: { location: "/login", ...buildSecurityHeaders() } });
          if (context || local || remoteAuth) {
            if (context?.accessSession) {
              const merged = new Headers(staticResponse.headers);
              for (const [k, v] of headers.entries()) merged.append(k, v);
              merged.set("x-csrf-token", context.csrf);
              return new Response(staticResponse.body, { status: staticResponse.status, headers: merged });
            }
            const sessionId = ensurePanelSessionCookie(req, headers, Boolean(remoteAuth));
            const session = panelSessions.get(sessionId);
            if (session) {
              const merged = new Headers(staticResponse.headers);
              for (const [k, v] of headers.entries()) merged.append(k, v);
              merged.set("x-csrf-token", session.csrf);
              return new Response(staticResponse.body, { status: staticResponse.status, headers: merged });
            }
          }
          return staticResponse;
        }
        const merged = new Headers(staticResponse.headers);
        for (const [k, v] of headers.entries()) merged.set(k, v);
        return new Response(staticResponse.body, { status: staticResponse.status, headers: merged });
      } catch (err) {
        if (err instanceof Response) return err;
        const status = Number(err.status) || 500;
        const level = status >= 500 ? "error" : "warn";
        if (level === "warn") {
          console.warn(`[web] Отклонён запрос ${req.method} ${url.pathname}: ${status} ${err.message}`);
        } else {
          console.error(`[web] Ошибка запроса ${req.method} ${url.pathname}:`, err);
        }
        return json({ error: err.message }, { status });
      }
    },
  });

  archiveExpiredHistory();
  historyCleanupTimer = setInterval(() => {
    try {
      archiveExpiredHistory();
    } catch (err) {
      console.error("[history] Не удалось очистить старую историю:", err.message);
    }
  }, 60 * 60_000);
  historyCleanupTimer.unref?.();
  console.log(`[web] Панель управления: http://127.0.0.1:${server.port}`);
  server.stopRemoteAccess = () => {
    unregisterRemoteAccess(client, remote);
    unregisterAccessControl(client);
    access.close();
    return remote.stop({ revokeSessions: false });
  };
  server.stopPanel = () => historyCleanupTimer && clearInterval(historyCleanupTimer);
  return server;
}
