import { createHash } from "node:crypto";
import ffmpegPath from "ffmpeg-static";
import play from "play-dl";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { StreamType } from "@discordjs/voice";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";

const YTDLP_PATH = (() => {
  for (const name of ["yt-dlp.exe", "yt-dlp"]) {
    const local = new URL(`../../bin/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    if (existsSync(local)) return local;
  }
  return "yt-dlp";
})();

const CACHE_DIR = fileURLToPath(new URL("../../data/cache/audio/", import.meta.url));
await mkdir(CACHE_DIR, { recursive: true });
const MAX_PLAYLIST_TRACKS = 500;
const cacheDownloads = new Map();

const MAX_CACHE_FILES = Number(process.env.AUDIO_CACHE_MAX_FILES) || 2000;
const MAX_CACHE_SIZE_BYTES = Number(process.env.AUDIO_CACHE_MAX_BYTES) || 8 * 1024 * 1024 * 1024;
const MAX_CACHE_AGE_MS = Number(process.env.AUDIO_CACHE_MAX_AGE_MS) || 14 * 24 * 60 * 60_000;
const CACHE_PRUNE_BATCH = Number(process.env.AUDIO_CACHE_PRUNE_BATCH) || 16;

const YTDLP_POT_PROVIDER_URL = process.env.YTDLP_POT_PROVIDER_URL?.trim() ?? "";
const YTDLP_PLAYER_CLIENT = process.env.YTDLP_PLAYER_CLIENT?.trim()
  || (YTDLP_POT_PROVIDER_URL ? "mweb" : "");

function optionalYtDlpArgs() {
  const args = [];
  if (YTDLP_PLAYER_CLIENT) {
    args.push("--extractor-args", `youtube:player_client=${YTDLP_PLAYER_CLIENT}`);
  }
  if (!YTDLP_POT_PROVIDER_URL) return args;

  let providerUrl;
  try {
    providerUrl = new URL(YTDLP_POT_PROVIDER_URL);
  } catch {
    throw new Error("YTDLP_POT_PROVIDER_URL должен быть корректным HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(providerUrl.protocol)) {
    throw new Error("YTDLP_POT_PROVIDER_URL поддерживает только HTTP(S)");
  }

  args.push(
    "--extractor-args", `youtubepot-bgutilhttp:base_url=${providerUrl.href.replace(/\/$/, "")}`,
  );
  return args;
}

export function parseStartTime(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Math.max(0, Number(raw));
  const clock = raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);
  if (clock) return (Number(clock[1]) || 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const units = [...raw.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)];
  if (units.length && units.map((match) => match[0]).join("") === raw) {
    return Math.floor(units.reduce((sum, match) => sum + Number(match[1]) * ({ h: 3600, m: 60, s: 1 }[match[2]]), 0));
  }
  return 0;
}

export function startTimeFromUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    const host = url.hostname.toLowerCase();
    if (host !== "youtu.be" && host !== "youtube.com" && !host.endsWith(".youtube.com")) return 0;
    return parseStartTime(url.searchParams.get("t") ?? url.searchParams.get("start"));
  } catch {
    return 0;
  }
}

function toTrack(video, requestedBy, sourceUrl = video.url) {
  return {
    url: video.url,
    title: video.title ?? video.url,
    durationSec: video.durationInSec ?? 0,
    thumbnail: video.thumbnails?.[0]?.url ?? null,
    requestedBy,
    startTimeSec: startTimeFromUrl(sourceUrl),
  };
}

function buildPlaylistUrl(listId, seedVideoId = "", pp = "") {
  if (listId.startsWith("RD")) {
    const derivedSeed = /^RD([A-Za-z0-9_-]{11})$/.exec(listId)?.[1] ?? "";
    const seed = /^[A-Za-z0-9_-]{11}$/.test(seedVideoId) ? seedVideoId : derivedSeed;
    if (seed) {
      const url = new URL("https://www.youtube.com/watch");
      url.searchParams.set("v", seed);
      url.searchParams.set("list", listId);
      url.searchParams.set("start_radio", "1");
      if (pp) url.searchParams.set("pp", pp);
      return url.href;
    }
  }
  return `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
}

function playlistUrlFromQuery(query) {
  const value = String(query ?? "").trim();
  const direct = value.match(/^list=([A-Za-z0-9_-]{10,128})$/i);
  if (direct) return buildPlaylistUrl(direct[1]);
  if (/^(?:PL|RD|UU|LL|FL|OLAK5uy)[A-Za-z0-9_-]{8,120}$/.test(value)) return buildPlaylistUrl(value);

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const isYouTube = host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
    const listId = isYouTube ? url.searchParams.get("list") : null;
    if (listId && /^[A-Za-z0-9_-]{10,128}$/.test(listId)) {
      return buildPlaylistUrl(listId, url.searchParams.get("v") ?? "", url.searchParams.get("pp") ?? "");
    }
  } catch {
    // no-op
  }
  return null;
}

function readYtDlpJson(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args, { timeout: timeoutMs });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 20 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp не смог прочитать плейлист: ${stderr.trim().slice(-500) || `код ${code}`}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("yt-dlp вернул некорректные данные плейлиста"));
      }
    });
  });
}

export async function resolvePlaylist(query, requestedBy) {
  const playlistUrl = playlistUrlFromQuery(query);
  if (!playlistUrl) return null;

  const info = await readYtDlpJson([
    "--flat-playlist",
    "--dump-single-json",
    "--skip-download",
    "--ignore-errors",
    "--playlist-end", String(MAX_PLAYLIST_TRACKS + 1),
    "--js-runtimes", "bun",
    ...optionalYtDlpArgs(),
    playlistUrl,
  ]);

  const entries = (info.entries ?? []).filter(Boolean);
  const tracks = entries.flatMap((entry) => {
    if (!entry.id || !entry.title) return [];
    return [{
      url: entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`,
      title: entry.title,
      durationSec: Number(entry.duration) || 0,
      thumbnail: entry.thumbnails?.at?.(-1)?.url ?? null,
      requestedBy,
    }];
  }).slice(0, MAX_PLAYLIST_TRACKS);

  const requestedStartTimeSec = startTimeFromUrl(query);
  if (requestedStartTimeSec > 0 && tracks.length) tracks[0].startTimeSec = requestedStartTimeSec;

  return {
    title: info.title || "YouTube playlist",
    url: playlistUrl,
    tracks,
    limited: entries.length > MAX_PLAYLIST_TRACKS,
  };
}

export async function resolveInput(query, requestedBy) {
  const playlist = await resolvePlaylist(query, requestedBy);
  if (playlist) return { kind: "playlist", ...playlist };

  const track = await resolveTrack(query, requestedBy);
  return { kind: "track", tracks: track ? [track] : [] };
}

export async function resolveTrack(query, requestedBy) {
  const validated = await play.validate(query);

  if (validated === "yt_video") {
    const info = await play.video_basic_info(query);
    return toTrack(info.video_details, requestedBy, query);
  }

  const results = await play.search(query, { limit: 1, source: { youtube: "video" } });
  if (!results.length) return null;
  return toTrack(results[0], requestedBy);
}

function cacheKeyFor(url, quality) {
  return createHash("sha1").update(`${url}|${quality}`).digest("hex");
}

async function inventory() {
  const entries = await readdir(CACHE_DIR).catch(() => []);
  const files = [];
  for (const file of entries) {
    if (file.endsWith(".part")) continue;
    const filePath = path.join(CACHE_DIR, file);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      files.push({ file: filePath, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // no-op
    }
  }
  return files;
}

async function pruneCache() {
  const files = await inventory();
  let current = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
  let totalBytes = current.reduce((sum, entry) => sum + entry.size, 0);
  let removed = 0;

  const old = current.filter((entry) => Date.now() - entry.mtimeMs > MAX_CACHE_AGE_MS);
  for (const entry of old) {
    try {
      await rm(entry.file, { force: true });
      removed += 1;
      totalBytes -= entry.size;
    } catch {
      // no-op
    }
  }
  if (old.length) current = current.filter((entry) => !old.includes(entry));

  current.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const overFiles = Math.max(0, current.length - MAX_CACHE_FILES);
  if (overFiles > 0) {
    const toDelete = current.slice(0, overFiles);
    for (const entry of toDelete) {
      try {
        await rm(entry.file, { force: true });
        removed += 1;
        totalBytes -= entry.size;
      } catch {
        // no-op
      }
    }
    current = current.slice(overFiles);
  }

  if (totalBytes > MAX_CACHE_SIZE_BYTES) {
    while (current.length && totalBytes > MAX_CACHE_SIZE_BYTES) {
      const batch = current.splice(0, CACHE_PRUNE_BATCH);
      for (const entry of batch) {
        try {
          await rm(entry.file, { force: true });
          removed += 1;
          totalBytes -= entry.size;
        } catch {
          // no-op
        }
      }
    }
  }
  if (removed) console.log(`[cache] Очистка кэша: удалено ${removed} файлов, размер теперь ${Math.round(totalBytes / 1024 / 1024)} MB`);
}

async function findCachedFile(key) {
  const prefix = `${key}.`;
  const entries = await readdir(CACHE_DIR);
  const match = entries.find((fileName) => fileName.startsWith(prefix) && !fileName.endsWith(".part"));
  return match ? path.join(CACHE_DIR, match) : null;
}

export async function getAudioCacheEntry(url, quality = "best") {
  const key = cacheKeyFor(url, quality);
  const file = await findCachedFile(key);
  if (!file) return null;
  const st = await stat(file).catch(() => null);
  if (!st) return null;
  return { file, fileName: path.basename(file), bytes: st.size, quality };
}

export function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function downloadToCache(url, quality, key) {
  return new Promise((resolve, reject) => {
    const format = quality === "best" ? "bestaudio/best" : "worstaudio/worst";
    const outTemplate = path.join(CACHE_DIR, `${key}.%(ext)s`);
    const timeoutMs = 5 * 60 * 1000;

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`yt-dlp истёк таймаут (${timeoutMs}ms) при скачивании в кэш`));
    }, timeoutMs);

    const child = spawn(
      YTDLP_PATH,
      [
        "-f", format,
        "--no-playlist",
        "--js-runtimes", "bun",
        ...optionalYtDlpArgs(),
        "--retries", "5",
        "--quiet",
        "--no-warnings",
        "-o", outTemplate,
        url,
      ],
      { timeout: timeoutMs }
    );

    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on("exit", async (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`yt-dlp завершился с кодом ${code} при скачивании в кэш: ${err.trim().slice(-500) || "нет вывода"}`));
        return;
      }
      const file = await findCachedFile(key);
      if (!file) {
        reject(new Error("yt-dlp завершился успешно, но файл кэша не найден"));
        return;
      }
      resolve(file);
    });
  });
}

export async function ensureCachedFile(url, quality = "best") {
  const key = cacheKeyFor(url, quality);
  const existing = await getAudioCacheEntry(url, quality);
  if (existing) {
    const sizeMB = formatMB(existing.bytes);
    console.log(`[cache] Использую кэш (${sizeMB} MB): ${existing.fileName}`);
    return existing.file;
  }

  const existingDownload = cacheDownloads.get(key);
  if (existingDownload) {
    console.log(`[cache] Уже скачивается, ожидаю общий результат: ${url} (quality=${quality})`);
    return existingDownload;
  }

  const promise = (async () => {
    const start = Date.now();
    const file = await downloadToCache(url, quality, key);
    const st = await stat(file).catch(() => null);
    if (!st) throw new Error("yt-dlp вернул файл, но не удалось прочитать его метаданные");
    const sizeMB = formatMB(st.size);
    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[cache] Скачано и закэшировано (${sizeMB} MB за ${elapsedSec}s): ${path.basename(file)}`);
    await pruneCache();
    return file;
  })();

  cacheDownloads.set(key, promise);

  try {
    return await promise;
  } finally {
    if (cacheDownloads.get(key) === promise) cacheDownloads.delete(key);
  }
}

export async function clearAudioCache() {
  const files = await readdir(CACHE_DIR).catch(() => []);
  let removed = 0;
  for (const file of files) {
    const filePath = path.join(CACHE_DIR, file);
    try {
      await rm(filePath, { force: true });
      removed += 1;
    } catch {
      // no-op
    }
  }
  return removed;
}

export async function getAudioCacheStats() {
  const entries = await inventory();
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  return { files: entries.length, totalMB: Number(formatMB(totalBytes)) };
}

export async function getAudioStream(url, quality = "best", startTimeSec = 0) {
  let localFile;
  try {
    localFile = await ensureCachedFile(url, quality);
  } catch (err) {
    throw new Error(`Не удалось скачать/закэшировать трек: ${err.message}`);
  }

  return new Promise((resolve, reject) => {
    const ffmpegTimeout = 90000;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`ffmpeg истёк таймаут (${ffmpegTimeout}ms) — возможно, повреждённый файл кэша`));
    }, ffmpegTimeout);

    const seekSeconds = Math.max(0, Number(startTimeSec) || 0);
    const child = spawn(
      ffmpegPath,
      [
        ...(seekSeconds > 0 ? ["-ss", seekSeconds.toFixed(3)] : []),
        "-i", localFile,
        "-analyzeduration", "0",
        "-probesize", "32",
        "-loglevel", "error",
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: ffmpegTimeout }
    );

    let stderrTail = "";
    const stats = { bytesOut: 0 };
    const meteredStream = new Transform({
      transform(chunk, _encoding, callback) {
        stats.bytesOut += chunk.length;
        callback(null, chunk);
      },
    });
    child.stdout.pipe(meteredStream);

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      if (!text.toLowerCase().includes("deprecated")) {
        console.error(`[ffmpeg] ${text.trim()}`);
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      reject(err);
    });

    meteredStream.once("readable", () => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      resolve({ stream: meteredStream, type: StreamType.Raw, process: child, quality, stats, localFile });
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(new Error(`ffmpeg завершился с кодом ${code} без единого байта аудио (quality=${quality}): ${stderrTail.trim().slice(-300) || "(нет вывода)"}`));
    });
  });
}
