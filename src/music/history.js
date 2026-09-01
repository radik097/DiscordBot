import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import {
  deleteMusicHistoryRow,
  getMusicHistoryRow,
  listMusicHistoryRows,
  upsertMusicHistory,
} from "../db.js";
import { AUDIO_CACHE_DIR } from "./source.js";

const CACHE_FILE_PATTERN = /^(?:[a-f0-9]{40}|(?:upload|cobalt)-[a-f0-9]{64})\.[a-z0-9]{1,10}$/i;

function safeGuildId(guildId) {
  const value = String(guildId ?? "");
  if (!/^\d{1,32}$/.test(value)) throw new Error("Некорректный ID сервера");
  return value;
}

function safeHistoryId(id) {
  const value = Number(id);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Некорректный ID истории");
  return value;
}

function cacheFileInside(cacheDir, localFile) {
  const root = path.resolve(cacheDir);
  const resolved = path.resolve(String(localFile ?? ""));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error("Аудиофайл находится вне музыкального кэша");
  }
  if (!CACHE_FILE_PATTERN.test(relative)) throw new Error("Некорректное имя файла музыкального кэша");
  return { cacheFile: relative, filePath: resolved };
}

export async function recordCachedTrack(guildId, track, localFile, {
  cacheDir = AUDIO_CACHE_DIR,
  playedAt = Date.now(),
} = {}) {
  const id = safeGuildId(guildId);
  const { cacheFile, filePath } = cacheFileInside(cacheDir, localFile);
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0) throw new Error("Файл музыкального кэша отсутствует или пуст");
  const url = String(track?.url ?? "").trim();
  if (!url) throw new Error("У трека отсутствует адрес источника");
  upsertMusicHistory({
    guildId: id,
    cacheFile,
    url: url.slice(0, 4096),
    title: String(track?.title || url).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300),
    durationSec: Math.max(0, Number(track?.durationSec) || 0),
    thumbnail: track?.thumbnail ? String(track.thumbnail).slice(0, 4096) : null,
    requestedBy: track?.requestedBy ? String(track.requestedBy).slice(0, 200) : null,
    sourceType: track?.sourceType ? String(track.sourceType).slice(0, 40) : null,
    sourceService: track?.sourceService ? String(track.sourceService).slice(0, 200) : null,
    sizeBytes: info.size,
    playedAt,
  });
}

export async function listCachedMusicHistory(guildId, { limit = 100, cacheDir = AUDIO_CACHE_DIR } = {}) {
  const id = safeGuildId(guildId);
  const available = new Set(await readdir(cacheDir).catch(() => []));
  const rows = listMusicHistoryRows(id, limit);
  const current = [];
  for (const row of rows) {
    if (CACHE_FILE_PATTERN.test(row.cacheFile) && available.has(row.cacheFile)) current.push(row);
    else deleteMusicHistoryRow(id, row.id);
  }
  return current;
}

export async function getCachedMusicHistoryTrack(guildId, historyId, requestedBy = "история кэша", {
  cacheDir = AUDIO_CACHE_DIR,
} = {}) {
  const id = safeGuildId(guildId);
  const row = getMusicHistoryRow(id, safeHistoryId(historyId));
  if (!row || !CACHE_FILE_PATTERN.test(row.cacheFile)) return null;
  const filePath = path.join(cacheDir, row.cacheFile);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile() || info.size <= 0) {
    deleteMusicHistoryRow(id, row.id);
    return null;
  }
  return {
    url: row.url,
    title: row.title,
    durationSec: Number(row.durationSec) || 0,
    thumbnail: row.thumbnail ?? null,
    requestedBy,
    startTimeSec: 0,
    cacheFile: row.cacheFile,
    sizeBytes: info.size,
    ...(row.sourceType ? { sourceType: row.sourceType } : {}),
    ...(row.sourceService ? { sourceService: row.sourceService } : {}),
  };
}
