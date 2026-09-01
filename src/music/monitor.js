import ffmpegPath from "ffmpeg-static";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { AUDIO_CACHE_DIR, ensureCachedFile, getAttachmentCacheEntry } from "./source.js";

const START_TIMEOUT_MS = 15_000;
const PREPARED_TTL_MS = 30 * 60_000;
const activeMonitors = new Map();
const preparedMonitors = new Map();

async function normalizedSourceFile(file) {
  const lexicalRoot = path.resolve(AUDIO_CACHE_DIR);
  const lexicalCandidate = path.resolve(String(file ?? ""));
  if (lexicalCandidate !== lexicalRoot && !lexicalCandidate.startsWith(lexicalRoot + path.sep)) {
    throw new Error("Файл мониторинга находится вне аудиокэша");
  }
  const [root, candidate] = await Promise.all([realpath(lexicalRoot), realpath(lexicalCandidate)]);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error("Файл мониторинга находится вне аудиокэша");
  }
  return candidate;
}

function normalizedVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error("Некорректная громкость мониторинга");
  return Math.max(0, Math.min(2, numeric));
}

export function stopMusicMonitor(key) {
  const current = activeMonitors.get(String(key));
  if (!current) return false;
  activeMonitors.delete(String(key));
  if (!current.killed) current.kill("SIGTERM");
  return true;
}

export async function prepareMusicMonitorTrack({ key, track }) {
  if (!track?.url) throw new Error("Трек для мониторинга не найден");
  const cacheEntry = ["attachment", "cobalt"].includes(track.sourceType)
    ? await getAttachmentCacheEntry(track.cacheFile)
    : { file: await ensureCachedFile(track.url, "best") };
  const prepared = {
    sourceId: randomUUID(),
    file: cacheEntry.file,
    track: {
      title: String(track.title || track.url),
      durationSec: Math.max(0, Number(track.durationSec) || 0),
      thumbnail: track.thumbnail ?? null,
    },
    expiresAt: Date.now() + PREPARED_TTL_MS,
  };
  preparedMonitors.set(String(key), prepared);
  return { sourceId: prepared.sourceId, track: prepared.track, expiresAt: prepared.expiresAt };
}

export function getPreparedMusicMonitor(key, sourceId) {
  const monitorKey = String(key);
  const prepared = preparedMonitors.get(monitorKey);
  if (!prepared) return null;
  if (prepared.expiresAt <= Date.now()) {
    preparedMonitors.delete(monitorKey);
    return null;
  }
  if (sourceId && prepared.sourceId !== sourceId) return null;
  return { ...prepared };
}

export function clearPreparedMusicMonitor(key) {
  stopMusicMonitor(key);
  return preparedMonitors.delete(String(key));
}

export async function startMusicMonitor({ key, file, offsetSec = 0, volume = 1 }) {
  const monitorKey = String(key || "default");
  const sourceFile = await normalizedSourceFile(file);
  const info = await stat(sourceFile).catch(() => null);
  if (!info?.isFile() || info.size <= 0) throw new Error("Аудиофайл для мониторинга недоступен");

  stopMusicMonitor(monitorKey);
  const gain = normalizedVolume(volume);
  const seek = Math.max(0, Number(offsetSec) || 0);
  const child = spawn(ffmpegPath, [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    ...(seek > 0 ? ["-ss", seek.toFixed(3)] : []),
    "-i", sourceFile,
    "-vn",
    "-filter:a", `volume=${gain.toFixed(4)}`,
    "-ar", "48000",
    "-ac", "2",
    "-codec:a", "libmp3lame",
    "-b:a", "128k",
    "-f", "mp3",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  activeMonitors.set(monitorKey, child);
  const output = new PassThrough();
  child.stdout.pipe(output);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });

  const cleanup = () => {
    if (activeMonitors.get(monitorKey) === child) activeMonitors.delete(monitorKey);
  };
  child.once("close", cleanup);
  child.once("error", cleanup);

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
      reject(new Error("Мониторинг не запустился за 15 секунд"));
    }, START_TIMEOUT_MS);
    output.once("readable", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (output.readableLength > 0) return;
      clearTimeout(timer);
      reject(new Error(`FFmpeg мониторинга завершился с кодом ${code}: ${stderr.trim() || "нет данных"}`));
    });
  });

  try {
    await ready;
  } catch (error) {
    stopMusicMonitor(monitorKey);
    throw error;
  }

  return {
    stream: output,
    process: child,
    stop: () => stopMusicMonitor(monitorKey),
    contentType: "audio/mpeg",
    volume: gain,
    offsetSec: seek,
  };
}
