import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { AUDIO_CACHE_DIR, pruneAudioCache } from "./source.js";

const DEFAULT_CACHE_DIR = AUDIO_CACHE_DIR;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DISCORD_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const attachmentDownloads = new Map();

export function getMaxAttachmentBytes(env = process.env) {
  const configured = Number(env.MUSIC_FILE_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_BYTES;
}

export function validateDiscordAttachmentUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new Error("Discord передал некорректную ссылку на файл");
  }
  if (url.protocol !== "https:" || !DISCORD_ATTACHMENT_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Разрешены только файлы, загруженные непосредственно в Discord");
  }
  if (!url.pathname.startsWith("/attachments/")) {
    throw new Error("Ссылка не является Discord-вложением");
  }
  return url;
}

function safeTitle(name) {
  const value = path.basename(String(name ?? "media-file"))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (value || "media-file").slice(0, 120);
}

function safeExtension(name) {
  const extension = path.extname(String(name ?? "")).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".media";
}

function attachmentCacheName(attachment) {
  const identity = [attachment.id, attachment.url, attachment.name, attachment.size].join("|");
  const digest = createHash("sha256").update(identity).digest("hex");
  return `upload-${digest}${safeExtension(attachment.name)}`;
}

async function downloadToCache(attachment, { fetchImpl, cacheDir, maxBytes }) {
  const url = validateDiscordAttachmentUrl(attachment.url);
  const declaredSize = Number(attachment.size) || 0;
  if (declaredSize > maxBytes) {
    throw new Error(`Файл слишком большой: максимум ${Math.floor(maxBytes / 1024 / 1024)} МБ`);
  }

  await mkdir(cacheDir, { recursive: true });
  const cacheFile = attachmentCacheName(attachment);
  const destination = path.join(cacheDir, cacheFile);
  const existing = await stat(destination).catch(() => null);
  if (existing?.isFile() && existing.size > 0 && existing.size <= maxBytes) {
    return { cacheFile, filePath: destination, bytes: existing.size, downloaded: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.part`;
  let handle;
  try {
    const response = await fetchImpl(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { "user-agent": "DiscordBot media attachment downloader" },
    });
    if (!response.ok) throw new Error(`Discord CDN вернул HTTP ${response.status}`);

    const contentLength = Number(response.headers.get("content-length")) || 0;
    if (contentLength > maxBytes) {
      throw new Error(`Файл слишком большой: максимум ${Math.floor(maxBytes / 1024 / 1024)} МБ`);
    }
    if (!response.body) throw new Error("Discord CDN вернул пустой ответ");

    handle = await open(temporary, "wx");
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`Файл превысил лимит ${Math.floor(maxBytes / 1024 / 1024)} МБ во время загрузки`);
      }
      await handle.write(chunk);
    }
    await handle.close();
    handle = null;
    if (!bytes) throw new Error("Загруженный файл пуст");
    await rename(temporary, destination);
    return { cacheFile, filePath: destination, bytes, downloaded: true };
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("Истекло время загрузки файла из Discord");
    throw err;
  } finally {
    clearTimeout(timeout);
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function probeMediaFile(filePath, { ffprobePath = process.env.FFPROBE_PATH || "ffprobe" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,duration",
      "-of", "json",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => reject(new Error(`Не удалось запустить ffprobe: ${err.message}`)));
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Формат не распознан FFmpeg: ${stderr.trim().slice(-300) || `код ${code}`}`));
        return;
      }
      try {
        const info = JSON.parse(stdout);
        const audio = (info.streams ?? []).find((stream) => stream.codec_type === "audio");
        if (!audio) throw new Error("Файл не содержит аудиодорожку");
        const durationSec = Number(info.format?.duration ?? audio.duration) || 0;
        resolve({
          durationSec: Math.max(0, durationSec),
          audioCodec: audio.codec_name ?? null,
          format: info.format?.format_name ?? null,
        });
      } catch (err) {
        reject(new Error(err.message === "Файл не содержит аудиодорожку" ? err.message : "ffprobe вернул некорректные метаданные"));
      }
    });
  });
}

export async function resolveAttachment(attachment, requestedBy, {
  fetchImpl = globalThis.fetch,
  probeImpl = probeMediaFile,
  cacheDir = DEFAULT_CACHE_DIR,
  maxBytes = getMaxAttachmentBytes(),
} = {}) {
  if (!attachment?.url) throw new Error("Прикрепите аудио- или видеофайл к команде");
  if (typeof fetchImpl !== "function") throw new Error("Загрузка файлов недоступна в текущем runtime");

  const key = attachmentCacheName(attachment);
  let pending = attachmentDownloads.get(key);
  if (!pending) {
    pending = downloadToCache(attachment, { fetchImpl, cacheDir, maxBytes });
    attachmentDownloads.set(key, pending);
  }

  let cached;
  try {
    cached = await pending;
    const metadata = await probeImpl(cached.filePath);
    if (cached.downloaded && path.resolve(cacheDir) === path.resolve(DEFAULT_CACHE_DIR)) {
      await pruneAudioCache();
    }
    const track = {
      sourceType: "attachment",
      url: attachment.url,
      cacheFile: cached.cacheFile,
      title: safeTitle(attachment.name),
      durationSec: metadata.durationSec,
      thumbnail: null,
      requestedBy,
      sizeBytes: cached.bytes,
      contentType: attachment.contentType ?? null,
    };
    return { kind: "file", title: track.title, tracks: [track] };
  } catch (err) {
    if (cached?.filePath) await rm(cached.filePath, { force: true }).catch(() => {});
    throw err;
  } finally {
    if (attachmentDownloads.get(key) === pending) attachmentDownloads.delete(key);
  }
}
