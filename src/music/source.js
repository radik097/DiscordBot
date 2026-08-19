import play from "play-dl";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
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
const MAX_PLAYLIST_TRACKS = 500;

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

function toTrack(video, requestedBy) {
  return {
    url: video.url,
    title: video.title ?? video.url,
    durationSec: video.durationInSec ?? 0,
    thumbnail: video.thumbnails?.[0]?.url ?? null,
    requestedBy,
  };
}

function buildPlaylistUrl(listId, seedVideoId = "", pp = "") {
  // Dynamic YouTube Mix playlists (RD...) cannot be opened through /playlist.
  // They must retain a seed video in a /watch URL. For the common RD<videoId>
  // form, the seed can be recovered directly from the playlist ID.
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

  // Also accept a bare YouTube playlist ID for convenience.
  if (/^(?:PL|RD|UU|LL|FL|OLAK5uy)[A-Za-z0-9_-]{8,120}$/.test(value)) {
    return buildPlaylistUrl(value);
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const isYouTube = host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
    const listId = isYouTube ? url.searchParams.get("list") : null;
    if (listId && /^[A-Za-z0-9_-]{10,128}$/.test(listId)) {
      return buildPlaylistUrl(listId, url.searchParams.get("v") ?? "", url.searchParams.get("pp") ?? "");
    }
  } catch {
    // A normal search query is not expected to be a URL.
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
    // Read one extra item so we can report that a long playlist was truncated.
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
        // YouTube requires a JavaScript runtime for signature challenges.
        // The app itself runs on Bun, so reuse that runtime for yt-dlp.
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
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
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

    let stderrTail = "";

    // Count decoded bytes through a Transform instead of a direct `data`
    // listener. This preserves stream backpressure so ffmpeg cannot run far
    // ahead of Discord playback and prematurely exhaust a long track.
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

    // `readable` confirms that ffmpeg produced audio without switching the
    // stream to flowing mode or consuming the first chunk.
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
