import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureCachedFile, getAudioCacheEntry } from "./source.js";

const PLAYLISTS_DIR = fileURLToPath(new URL("../../data/playlists/", import.meta.url));
const DOWNLOAD_CONCURRENCY = 2;
const jobs = new Map();
let activeDownloads = 0;
const downloadWaiters = [];

mkdirSync(PLAYLISTS_DIR, { recursive: true });

function safeGuildId(guildId) {
  const value = String(guildId ?? "");
  if (!/^\d{1,32}$/.test(value)) throw new Error("Некорректный ID сервера");
  return value;
}

function playlistDirectory(guildId) {
  const directory = path.join(PLAYLISTS_DIR, safeGuildId(guildId));
  mkdirSync(directory, { recursive: true });
  return directory;
}

function normalizePlaylistTitle(title) {
  const value = String(title ?? "").replace(/\s+/g, " ").trim();
  if (!value) throw new Error("Введите имя плейлиста");
  if (value.length > 100) throw new Error("Имя плейлиста не должно быть длиннее 100 символов");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Имя плейлиста содержит недопустимые символы");
  return value;
}

function safeManifestId(manifestId) {
  const value = String(manifestId ?? "");
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw new Error("Некорректный ID плейлиста");
  return value;
}

function publicJob(job, extra = {}) {
  if (!job) return null;
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    total: job.total,
    completed: job.completed,
    downloaded: job.downloaded,
    alreadyCached: job.alreadyCached,
    failed: job.failed,
    currentTitle: job.currentTitle,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    updatedAt: job.updatedAt,
    relativeManifest: job.relativeManifest,
    error: job.error ?? null,
    ...extra,
  };
}

function persistJob(job) {
  job.updatedAt = Date.now();
  const payload = {
    version: 1,
    ...publicJob(job),
    guildId: job.guildId,
    tracks: job.tracks,
  };
  const temporary = `${job.manifestPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(payload, null, 2), "utf8");
  renameSync(temporary, job.manifestPath);
}

function acquireDownloadSlot() {
  if (activeDownloads < DOWNLOAD_CONCURRENCY) {
    activeDownloads += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    downloadWaiters.push(() => {
      activeDownloads += 1;
      resolve();
    });
  });
}

async function withDownloadSlot(task) {
  await acquireDownloadSlot();
  try {
    return await task();
  } finally {
    activeDownloads -= 1;
    downloadWaiters.shift()?.();
  }
}

function latestManifest(guildId) {
  const directory = playlistDirectory(guildId);
  const latest = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .at(-1);
  if (!latest) return null;
  try {
    return JSON.parse(readFileSync(path.join(directory, latest), "utf8"));
  } catch (err) {
    console.error(`[library:${guildId}] Не удалось прочитать ${latest}:`, err.message);
    return null;
  }
}

export function listSavedPlaylists(guildId) {
  const id = safeGuildId(guildId);
  const directory = playlistDirectory(id);
  const latestByTitle = new Map();
  const manifests = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse();

  for (const manifestName of manifests) {
    let saved;
    try {
      saved = JSON.parse(readFileSync(path.join(directory, manifestName), "utf8"));
    } catch (err) {
      console.warn(`[library:${id}] Пропускаю повреждённый манифест ${manifestName}: ${err.message}`);
      continue;
    }
    if (!saved || !Array.isArray(saved.tracks)) continue;
    const title = String(saved.title || "Без названия").trim() || "Без названия";
    const key = title.toLocaleLowerCase("ru-RU");
    const existing = latestByTitle.get(key);
    if (existing) {
      existing.versions += 1;
      continue;
    }
    latestByTitle.set(key, {
      ...publicJob(saved),
      id: saved.id || manifestName.slice(0, -5),
      title,
      versions: 1,
    });
  }

  return [...latestByTitle.values()].sort((a, b) => Number(b.updatedAt || b.startedAt) - Number(a.updatedAt || a.startedAt));
}

export function getSavedPlaylist(guildId, manifestId) {
  const id = safeGuildId(guildId);
  const safeId = safeManifestId(manifestId);
  const manifestPath = path.join(playlistDirectory(id), `${safeId}.json`);
  if (!existsSync(manifestPath)) return null;
  try {
    const saved = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!saved || !Array.isArray(saved.tracks)) return null;
    return {
      ...publicJob(saved),
      id: saved.id || safeId,
      guildId: id,
      tracks: saved.tracks,
    };
  } catch (err) {
    console.warn(`[library:${id}] Не удалось открыть плейлист ${safeId}: ${err.message}`);
    return null;
  }
}

async function downloadTrack(job, index) {
  const track = job.tracks[index];
  track.status = "downloading";
  job.currentTitle = track.title;
  persistJob(job);

  try {
    const cachedBefore = getAudioCacheEntry(track.url, "best");
    const file = await withDownloadSlot(() => ensureCachedFile(track.url, "best"));
    const cachedAfter = getAudioCacheEntry(track.url, "best");
    track.status = cachedBefore ? "cached" : "downloaded";
    track.cacheFile = cachedAfter?.fileName ?? path.basename(file);
    track.bytes = cachedAfter?.bytes ?? null;
    if (cachedBefore) job.alreadyCached += 1;
    else job.downloaded += 1;
  } catch (err) {
    track.status = "failed";
    track.error = String(err?.message ?? err).slice(0, 500);
    job.failed += 1;
  } finally {
    job.completed += 1;
    persistJob(job);
  }
}

async function runJob(job) {
  const pendingIndexes = job.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.status === "pending" || track.status === "downloading")
    .map(({ index }) => index);
  let cursor = 0;
  const worker = async () => {
    while (cursor < pendingIndexes.length) {
      const index = pendingIndexes[cursor];
      cursor += 1;
      await downloadTrack(job, index);
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, pendingIndexes.length) }, () => worker()),
    );
    job.status = job.failed ? "completed_with_errors" : "completed";
  } catch (err) {
    job.status = "failed";
    job.error = String(err?.message ?? err).slice(0, 500);
  } finally {
    job.currentTitle = null;
    job.finishedAt = Date.now();
    try {
      persistJob(job);
    } catch (err) {
      console.error(`[library:${job.guildId}] Не удалось записать итоговый манифест:`, err.message);
    }
  }
}

function launchJob(job) {
  void runJob(job).catch((err) => {
    job.status = "failed";
    job.error = String(err?.message ?? err).slice(0, 500);
    job.finishedAt = Date.now();
    console.error(`[library:${job.guildId}] Фоновая задача завершилась аварийно:`, job.error);
    try {
      persistJob(job);
    } catch (persistError) {
      console.error(`[library:${job.guildId}] Не удалось сохранить ошибку задачи:`, persistError.message);
    }
  });
}

export function startPlaylistSave(guildId, tracks, title = "Текущий плейлист") {
  const id = safeGuildId(guildId);
  const active = jobs.get(id);
  if (active?.status === "running") return publicJob(active, { alreadyRunning: true });

  const snapshot = (tracks ?? [])
    .filter((track) => track?.url)
    .map((track, index) => ({
      position: index + 1,
      url: track.url,
      title: track.title || track.url,
      durationSec: Number(track.durationSec) || 0,
      thumbnail: track.thumbnail ?? null,
      requestedBy: track.requestedBy ?? null,
      status: "pending",
    }));
  if (!snapshot.length) throw new Error("В текущем плейлисте нет треков для сохранения");

  const startedAt = Date.now();
  const jobId = `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const manifestPath = path.join(playlistDirectory(id), `${jobId}.json`);
  const job = {
    id: jobId,
    guildId: id,
    title: normalizePlaylistTitle(title || "Текущий плейлист"),
    status: "running",
    total: snapshot.length,
    completed: 0,
    downloaded: 0,
    alreadyCached: 0,
    failed: 0,
    currentTitle: null,
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
    relativeManifest: path.posix.join("playlists", id, `${jobId}.json`),
    manifestPath,
    tracks: snapshot,
  };
  persistJob(job);
  jobs.set(id, job);
  launchJob(job);
  return publicJob(job, { alreadyRunning: false });
}

export function getPlaylistSaveStatus(guildId) {
  const id = safeGuildId(guildId);
  const active = jobs.get(id);
  if (active) return publicJob(active);
  const saved = latestManifest(id);
  return saved ? publicJob(saved) : null;
}

export function resumePlaylistSaveJobs() {
  let resumed = 0;
  for (const guildEntry of readdirSync(PLAYLISTS_DIR, { withFileTypes: true })) {
    if (!guildEntry.isDirectory() || !/^\d{1,32}$/.test(guildEntry.name)) continue;
    if (jobs.get(guildEntry.name)?.status === "running") continue;
    const directory = path.join(PLAYLISTS_DIR, guildEntry.name);
    const manifests = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();

    for (const manifestName of manifests) {
      let saved;
      try {
        saved = JSON.parse(readFileSync(path.join(directory, manifestName), "utf8"));
      } catch (err) {
        console.error(`[library:${guildEntry.name}] Повреждён манифест ${manifestName}:`, err.message);
        continue;
      }
      if (saved.status !== "running" || !Array.isArray(saved.tracks)) continue;

      for (const track of saved.tracks) {
        if (track.status === "downloading") track.status = "pending";
      }
      const successful = saved.tracks.filter((track) => ["cached", "downloaded"].includes(track.status));
      const failed = saved.tracks.filter((track) => track.status === "failed");
      const job = {
        ...saved,
        guildId: guildEntry.name,
        status: "running",
        total: saved.tracks.length,
        completed: successful.length + failed.length,
        downloaded: successful.filter((track) => track.status === "downloaded").length,
        alreadyCached: successful.filter((track) => track.status === "cached").length,
        failed: failed.length,
        currentTitle: null,
        finishedAt: null,
        manifestPath: path.join(directory, manifestName),
        relativeManifest: path.posix.join("playlists", guildEntry.name, manifestName),
      };
      jobs.set(guildEntry.name, job);
      persistJob(job);
      launchJob(job);
      resumed += 1;
      break;
    }
  }
  if (resumed) console.log(`[library] Возобновлено фоновых сохранений: ${resumed}`);
  return resumed;
}
