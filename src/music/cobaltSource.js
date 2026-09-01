import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { CobaltClient, sanitizeSourceUrl, validatePublicMediaUrl } from "../downloads/cobalt.js";

const DEFAULT_CACHE_DIR = fileURLToPath(new URL("../../data/cache/audio/", import.meta.url));
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const cobaltDownloads = new Map();

export function getMaxCobaltMusicBytes(env = process.env) {
  const configured = Number(env.COBALT_MUSIC_MAX_BYTES);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  const shared = Number(env.MUSIC_FILE_MAX_BYTES);
  return Number.isFinite(shared) && shared > 0 ? Math.floor(shared) : DEFAULT_MAX_BYTES;
}

export function isYouTubeUrl(value) {
  try {
    const host = new URL(String(value ?? "").trim()).hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

export function isCobaltMusicUrl(value) {
  try {
    const url = validatePublicMediaUrl(value);
    return !isYouTubeUrl(url);
  } catch {
    return false;
  }
}

function safeExtension(filename, contentType = "") {
  const fromName = path.extname(String(filename ?? "")).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(fromName)) return fromName;
  const subtype = String(contentType).split(";")[0].split("/")[1]?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!subtype) return ".media";
  return `.${subtype === "mpeg" ? "mp3" : subtype === "oggopus" ? "opus" : subtype.slice(0, 10)}`;
}

function titleFromFilename(filename, hostname) {
  const base = path.basename(String(filename || "")).replace(path.extname(String(filename || "")), "");
  if (/^cobalt-[a-f0-9]{64}$/i.test(base)) return `Аудио с ${hostname}`;
  const title = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return (title || `Аудио с ${hostname}`).slice(0, 200);
}

async function findCached(cacheDir, key) {
  const prefix = `cobalt-${key}.`;
  const entries = await readdir(cacheDir).catch(() => []);
  const name = entries.find((entry) => entry.startsWith(prefix) && !entry.endsWith(".part"));
  if (!name) return null;
  const filePath = path.join(cacheDir, name);
  const info = await stat(filePath).catch(() => null);
  return info?.isFile() && info.size > 0 ? { cacheFile: name, filePath, bytes: info.size, downloaded: false } : null;
}

async function fetchWithSafeRedirects(client, initialUrl, fetchImpl, signal) {
  let current = client.validateResultUrl(initialUrl);
  for (let count = 0; count <= 5; count += 1) {
    const response = await fetchImpl(current, { redirect: "manual", signal, headers: { "user-agent": "DiscordBot Cobalt music resolver" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Cobalt вернул перенаправление без адреса");
    current = client.validateResultUrl(new URL(location, current).toString());
  }
  throw new Error("Слишком много перенаправлений от Cobalt");
}

async function downloadCobaltAudio(sourceUrl, { client, fetchImpl, cacheDir, maxBytes, timeoutMs }) {
  const source = validatePublicMediaUrl(sourceUrl);
  const key = createHash("sha256").update(source.toString()).digest("hex");
  await mkdir(cacheDir, { recursive: true });
  const existing = await findCached(cacheDir, key);
  if (existing && existing.bytes <= maxBytes) return { ...existing, filename: existing.cacheFile, source };
  if (existing) await rm(existing.filePath, { force: true });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let handle;
  let temporary;
  try {
    const resolved = await client.resolve(source, {
      signal: controller.signal,
      downloadMode: "audio",
      audioFormat: "best",
      localProcessing: "disabled",
    });
    const response = await fetchWithSafeRedirects(client, resolved.url, fetchImpl, controller.signal);
    if (!response.ok || !response.body) throw new Error(`Cobalt не отдал аудиофайл (HTTP ${response.status})`);
    const announced = Number(response.headers.get("content-length") || response.headers.get("estimated-content-length") || 0);
    if (announced > maxBytes) throw new Error(`Аудио превышает лимит ${Math.floor(maxBytes / 1024 / 1024)} МБ`);

    const contentType = response.headers.get("content-type") || "";
    const cacheFile = `cobalt-${key}${safeExtension(resolved.filename, contentType)}`;
    const destination = path.join(cacheDir, cacheFile);
    temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.part`;
    handle = await open(temporary, "wx");
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error(`Аудио превысило лимит ${Math.floor(maxBytes / 1024 / 1024)} МБ во время загрузки`);
      await handle.write(chunk);
    }
    await handle.close();
    handle = null;
    if (!bytes) throw new Error("Cobalt вернул пустой аудиофайл");
    await rename(temporary, destination);
    temporary = null;
    return { cacheFile, filePath: destination, bytes, downloaded: true, filename: resolved.filename, contentType, source, itemCount: resolved.itemCount || 1 };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Истекло время получения аудио через Cobalt");
    throw error;
  } finally {
    clearTimeout(timeout);
    await handle?.close().catch(() => {});
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function resolveCobaltTrack(sourceUrl, requestedBy, {
  client = new CobaltClient(),
  fetchImpl = globalThis.fetch,
  probeImpl = null,
  cacheDir = DEFAULT_CACHE_DIR,
  maxBytes = getMaxCobaltMusicBytes(),
  timeoutMs = Number(process.env.COBALT_MUSIC_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  pruneImpl = async () => (await import("./source.js")).pruneAudioCache(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Загрузка через Cobalt недоступна в текущем runtime");
  const source = validatePublicMediaUrl(sourceUrl);
  const key = createHash("sha256").update(source.toString()).digest("hex");
  let pending = cobaltDownloads.get(key);
  if (!pending) {
    pending = downloadCobaltAudio(source, { client, fetchImpl, cacheDir, maxBytes, timeoutMs });
    cobaltDownloads.set(key, pending);
  }
  let cached;
  try {
    cached = await pending;
    const probe = probeImpl || (await import("./attachment.js")).probeMediaFile;
    const metadata = await probe(cached.filePath);
    if (cached.downloaded && path.resolve(cacheDir) === path.resolve(DEFAULT_CACHE_DIR)) await pruneImpl();
    return {
      sourceType: "cobalt",
      url: sanitizeSourceUrl(source),
      cacheFile: cached.cacheFile,
      title: titleFromFilename(cached.filename, source.hostname),
      durationSec: metadata.durationSec,
      thumbnail: null,
      requestedBy,
      sizeBytes: cached.bytes,
      contentType: cached.contentType || null,
      sourceService: source.hostname,
      pickerItemCount: cached.itemCount || 1,
    };
  } catch (error) {
    if (cached?.filePath) await rm(cached.filePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    if (cobaltDownloads.get(key) === pending) cobaltDownloads.delete(key);
  }
}
