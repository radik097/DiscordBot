import play from "play-dl";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { StreamType } from "@discordjs/voice";

const YTDLP_PATH = (() => {
  // Windows dev checkout ships bin/yt-dlp.exe; the Docker image (linux) ships
  // bin/yt-dlp with no extension. Check both before falling back to PATH.
  for (const name of ["yt-dlp.exe", "yt-dlp"]) {
    const local = new URL(`../../bin/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    if (existsSync(local)) return local;
  }
  return "yt-dlp"; // fall back to a system-installed yt-dlp on PATH
})();

const CACHE_DIR = fileURLToPath(new URL("../../data/cache/audio/", import.meta.url));
mkdirSync(CACHE_DIR, { recursive: true });

function toTrack(video, requestedBy) {
  return {
    url: video.url,
    title: video.title ?? video.url,
    durationSec: video.durationInSec ?? 0,
    thumbnail: video.thumbnails?.[0]?.url ?? null,
    requestedBy,
  };
}

// Accepts either a YouTube URL or a free-text search query.
export async function resolveTrack(query, requestedBy) {
  const validated = await play.validate(query);

  if (validated === "yt_video") {
    const info = await play.video_basic_info(query);
    return toTrack(info.video_details, requestedBy);
  }

  // Anything else (plain search text, or a URL type we don't special-case)
  // goes through search — most reliable path for "search: <query>" style input.
  const results = await play.search(query, { limit: 1, source: { youtube: "video" } });
  if (!results.length) return null;
  return toTrack(results[0], requestedBy);
}

function cacheKeyFor(url, quality) {
  return createHash("sha1").update(`${url}|${quality}`).digest("hex");
}

// Finds an already-downloaded cache file for this key (any extension),
// ignoring partial ".part" files left behind by an interrupted download.
function findCachedFile(key) {
  const prefix = `${key}.`;
  const entries = readdirSync(CACHE_DIR);
  const match = entries.find((f) => f.startsWith(prefix) && !f.endsWith(".part"));
  return match ? path.join(CACHE_DIR, match) : null;
}

function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

// Downloads the audio-only stream to a local file via yt-dlp so repeated
// plays of the same track are served from disk instead of re-fetched/
// re-transcoded from the network every time.
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
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`yt-dlp завершился с кодом ${code} при скачивании в кэш: ${err.trim().slice(-500) || "нет вывода"}`));
        return;
      }
      const file = findCachedFile(key);
      if (!file) {
        reject(new Error("yt-dlp завершился успешно, но файл кэша не найден"));
        return;
      }
      resolve(file);
    });
  });
}

// Returns a local file path for this track, downloading+caching it first if needed.
async function ensureCachedFile(url, quality) {
  const key = cacheKeyFor(url, quality);
  const existing = findCachedFile(key);
  if (existing) {
    const sizeMB = formatMB(statSync(existing).size);
    console.log(`[cache] Использую кэш (${sizeMB} MB): ${path.basename(existing)}`);
    return existing;
  }

  console.log(`[cache] В кэше нет, скачиваю: ${url} (quality=${quality})`);
  const start = Date.now();
  const file = await downloadToCache(url, quality, key);
  const sizeMB = formatMB(statSync(file).size);
  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[cache] Скачано и закэшировано (${sizeMB} MB за ${elapsedSec}s): ${path.basename(file)}`);
  return file;
}

export function clearAudioCache() {
  const entries = readdirSync(CACHE_DIR);
  for (const f of entries) unlinkSync(path.join(CACHE_DIR, f));
  return entries.length;
}

export function getAudioCacheStats() {
  const entries = readdirSync(CACHE_DIR).filter((f) => !f.endsWith(".part"));
  const totalBytes = entries.reduce((sum, f) => sum + statSync(path.join(CACHE_DIR, f)).size, 0);
  return { files: entries.length, totalMB: Number(formatMB(totalBytes)) };
}

export async function getAudioStream(url, quality = "best") {
  let localFile;
  try {
    localFile = await ensureCachedFile(url, quality);
  } catch (err) {
    throw new Error(`Не удалось скачать/закэшировать трек: ${err.message}`);
  }

  return new Promise((resolve, reject) => {
    const ffmpegTimeout = 90000;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`ffmpeg истёк таймаут (${ffmpegTimeout}ms) — возможно, повреждённый файл кэша`));
    }, ffmpegTimeout);

    // Reading from a local cached file now, so no -reconnect flags needed —
    // that eliminates network-hiccup stutter during playback entirely.
    const child = spawn(
      ffmpegPath,
      [
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

    let settled = false;
    let stderrTail = "";

    // Live byte-throughput stats, read by queue.js to log buffered vs. played MB/s.
    const stats = { bytesOut: 0 };
    child.stdout.on("data", (chunk) => {
      stats.bytesOut += chunk.length;
    });

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

    child.stdout.once("data", () => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      resolve({ stream: child.stdout, type: StreamType.Raw, process: child, quality, stats, localFile });
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(new Error(`ffmpeg завершился с кодом ${code} без единого байта аудио (quality=${quality}): ${stderrTail.trim().slice(-300) || "(нет вывода)"}`));
    });
  });
}
