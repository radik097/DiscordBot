import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { ensureCachedFile, getAudioCacheEntry } from "./source.js";

const PLAYLISTS_DIR = fileURLToPath(new URL("../../data/playlists/", import.meta.url));
const DOWNLOAD_CONCURRENCY = 2;
const MAX_PLAYLIST_MANIFESTS = Number(process.env.PLAYLIST_MAX_MANIFESTS) || 120;
const MAX_TRACKS_PER_MANIFEST = Number(process.env.PLAYLIST_MAX_TRACKS) || 5000;
const jobs = new Map();
const downloadWaiters = [];
let activeDownloads = 0;

await mkdir(PLAYLISTS_DIR, { recursive: true });

function safeGuildId(guildId) {
  const value = String(guildId ?? "");
  if (!/^\d{1,32}$/.test(value)) throw new Error("Некорректный ID сервера");
  return value;
}

async function playlistDirectory(guildId) {
  const directory = path.join(PLAYLISTS_DIR, safeGuildId(guildId));
  await mkdir(directory, { recursive: true });
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
    name: job.title,
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

async function persistJob(job) {
  job.updatedAt = Date.now();
  const payload = {
    version: 2,
    ...publicJob(job),
    guildId: job.guildId,
    tracks: job.tracks,
    playback: job.playback ?? null,
  };
  const temporary = `${job.manifestPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(payload, null, 2), "utf8");
  await rename(temporary, job.manifestPath);
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

async function pruneGuildPlaylists(directory) {
  const entries = await readdir(directory).catch(() => []);
  const manifestFiles = entries.filter((name) => name.endsWith(".json")).sort().reverse();
  if (manifestFiles.length <= MAX_PLAYLIST_MANIFESTS) return;

  const removable = manifestFiles.slice(MAX_PLAYLIST_MANIFESTS);
  for (const manifestName of removable) {
    try {
      await rm(path.join(directory, manifestName), { force: true });
    } catch (err) {
      console.warn(`[library] Не удалось удалить старый плейлист ${manifestName}:`, err.message);
    }
  }
}

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (err) {
    console.warn(`[library] Не удалось прочитать манифест ${path.basename(manifestPath)}:`, err.message);
    return null;
  }
}

export async function listSavedPlaylists(guildId) {
  const id = safeGuildId(guildId);
  const directory = await playlistDirectory(id);
  const manifests = await readdir(directory).catch(() => []);
  const result = [];
  for (const manifestName of manifests.filter((name) => name.endsWith(".json")).sort().reverse()) {
    const manifestPath = path.join(directory, manifestName);
    const saved = await readManifest(manifestPath);
    if (!saved || !Array.isArray(saved.tracks)) continue;
    const title = String(saved.title || saved.name || "Без названия").trim() || "Без названия";
    result.push({
      ...publicJob(saved),
      id: saved.id || manifestName.slice(0, -5),
      title,
      name: title,
    });
  }
  await pruneGuildPlaylists(directory);
  return result.sort((a, b) => Number(b.updatedAt || b.startedAt) - Number(a.updatedAt || a.startedAt));
}

export async function getSavedPlaylist(guildId, manifestId) {
  const id = safeGuildId(guildId);
  const safeId = safeManifestId(manifestId);
  const manifestPath = path.join(await playlistDirectory(id), `${safeId}.json`);
  const saved = await readManifest(manifestPath);
  if (!saved || !Array.isArray(saved.tracks)) return null;
  return {
    ...publicJob(saved),
    id: saved.id || safeId,
    guildId: id,
    tracks: saved.tracks,
    playback: saved.playback ?? null,
  };
}

function playlistSnapshot(tracks) {
  return (tracks ?? []).filter((track) => track?.url).map((track, index) => ({
    position: index + 1,
    url: track.url,
    title: track.title || track.url,
    durationSec: Number(track.durationSec) || 0,
    startTimeSec: Math.max(0, Number(track.startTimeSec) || 0),
    thumbnail: track.thumbnail ?? null,
    requestedBy: track.requestedBy ?? null,
  }));
}

export async function savePlaylistPlaybackState(guildId, manifestId, tracks) {
  const id = safeGuildId(guildId);
  const safeId = safeManifestId(manifestId);
  const manifestPath = path.join(await playlistDirectory(id), `${safeId}.json`);
  const raw = await readManifest(manifestPath);
  if (!raw) return false;

  const playback = { updatedAt: Date.now(), tracks: playlistSnapshot(tracks) };
  const active = jobs.get(id);
  if (active?.id === safeId) {
    active.playback = playback;
    await persistJob(active);
    return true;
  }
  raw.version = 2;
  raw.playback = playback;
  raw.updatedAt = Date.now();
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(raw, null, 2), "utf8");
  await rename(temporary, manifestPath);
  return true;
}

export async function clearPlaylistPlaybackState(guildId, manifestId) {
  const id = safeGuildId(guildId);
  const safeId = safeManifestId(manifestId);
  const manifestPath = path.join(await playlistDirectory(id), `${safeId}.json`);
  const raw = await readManifest(manifestPath);
  if (!raw) return false;
  if (jobs.get(id)?.id === safeId) {
    jobs.get(id).playback = null;
    await persistJob(jobs.get(id));
    return true;
  }
  raw.version = 2;
  raw.playback = null;
  raw.updatedAt = Date.now();
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(raw, null, 2), "utf8");
  await rename(temporary, manifestPath);
  return true;
}

async function downloadTrack(job, index) {
  const track = job.tracks[index];
  track.status = "downloading";
  job.currentTitle = track.title;
  await persistJob(job);

  try {
    const cachedBefore = await getAudioCacheEntry(track.url, "best");
    const file = await withDownloadSlot(() => ensureCachedFile(track.url, "best"));
    const cachedAfter = await getAudioCacheEntry(track.url, "best");
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
    await persistJob(job);
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
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, pendingIndexes.length) }, () => worker()));
    job.status = job.failed ? "completed_with_errors" : "completed";
  } catch (err) {
    job.status = "failed";
    job.error = String(err?.message ?? err).slice(0, 500);
  } finally {
    job.currentTitle = null;
    job.finishedAt = Date.now();
    try {
      await persistJob(job);
      await pruneGuildPlaylists(path.dirname(job.manifestPath));
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
    void persistJob(job);
  });
}

export async function startPlaylistSave(guildId, tracks, title = "Текущий плейлист") {
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
      startTimeSec: Math.max(0, Number(track.startTimeSec) || 0),
      thumbnail: track.thumbnail ?? null,
      requestedBy: track.requestedBy ?? null,
      status: "pending",
    }));
  if (!snapshot.length) throw new Error("В текущем плейлисте нет треков для сохранения");

  const directory = await playlistDirectory(id);
  const startedAt = Date.now();
  const jobId = `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const manifestPath = path.join(directory, `${jobId}.json`);
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
  await persistJob(job);
  jobs.set(id, job);
  launchJob(job);
  return publicJob(job, { alreadyRunning: false });
}

export async function getPlaylistSaveStatus(guildId) {
  const id = safeGuildId(guildId);
  const active = jobs.get(id);
  if (active) return publicJob(active);

  const directory = await playlistDirectory(id);
  const manifests = (await readdir(directory).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse();
  const latest = manifests[0];
  if (!latest) return null;
  const saved = await readManifest(path.join(directory, latest));
  return saved ? publicJob(saved) : null;
}

export async function resumePlaylistSaveJobs() {
  let resumed = 0;
  const guildEntries = await readdir(PLAYLISTS_DIR, { withFileTypes: true }).catch(() => []);
  for (const guildEntry of guildEntries) {
    if (!guildEntry.isDirectory() || !/^\d{1,32}$/.test(guildEntry.name)) continue;
    if (jobs.get(guildEntry.name)?.status === "running") continue;
    const directory = path.join(PLAYLISTS_DIR, guildEntry.name);
    const manifests = (await readdir(directory).catch(() => []))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
    for (const manifestName of manifests) {
      const saved = await readManifest(path.join(directory, manifestName));
      if (!saved || saved.status !== "running" || !Array.isArray(saved.tracks)) continue;

      for (const track of saved.tracks) {
        if (track.status === "downloading") track.status = "pending";
      }
      const successful = saved.tracks.filter((track) => ["cached", "downloaded"].includes(track.status));
      const failed = saved.tracks.filter((track) => track.status === "failed");
      const job = {
        ...saved,
        guildId: guildEntry.name,
        status: "running",
        total: Math.min(MAX_TRACKS_PER_MANIFEST, saved.tracks.length),
        completed: Math.min(MAX_TRACKS_PER_MANIFEST, successful.length + failed.length),
        downloaded: successful.filter((track) => track.status === "downloaded").length,
        alreadyCached: successful.filter((track) => track.status === "cached").length,
        failed: failed.length,
        currentTitle: null,
        finishedAt: null,
        manifestPath: path.join(directory, manifestName),
        relativeManifest: path.posix.join("playlists", guildEntry.name, manifestName),
      };
      jobs.set(guildEntry.name, job);
      await persistJob(job);
      launchJob(job);
      resumed += 1;
      break;
    }
  }
  if (resumed) console.log(`[library] Возобновлено фоновых сохранений: ${resumed}`);
  return resumed;
}
