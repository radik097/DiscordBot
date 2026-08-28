import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, resolve as resolvePath, sep } from "node:path";
import { once } from "node:events";
import { CobaltClient, sanitizeSourceUrl } from "./cobalt.js";
import { createDownloadRecord, listDownloadRecords, updateDownloadRecord } from "../db.js";

const DOWNLOAD_ROOT = new URL("../../data/downloads/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;
const DEFAULT_TTL_MS = 30 * 60_000;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function safeFilename(value, contentType = "") {
  let name = basename(String(value || "download")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  if (!name || name === "." || name === "..") name = "download";
  if (!extname(name)) {
    const subtype = String(contentType).split(";")[0].split("/")[1]?.replace(/[^a-z0-9]/gi, "");
    if (subtype) name += `.${subtype === "quicktime" ? "mov" : subtype}`;
  }
  return name.slice(-180);
}

export class DownloadService {
  constructor({
    cobalt = new CobaltClient(),
    fetchImpl = fetch,
    root = DOWNLOAD_ROOT,
    maxBytes = positiveNumber(process.env.DOWNLOAD_MAX_BYTES, DEFAULT_MAX_BYTES),
    concurrency = positiveNumber(process.env.DOWNLOAD_CONCURRENCY, 2),
    maxQueue = positiveNumber(process.env.DOWNLOAD_QUEUE_MAX, 20),
    cooldownMs = positiveNumber(process.env.DOWNLOAD_COOLDOWN_MS, 30_000),
    linkTtlMs = positiveNumber(process.env.DOWNLOAD_LINK_TTL_MS, DEFAULT_TTL_MS),
    publicBaseUrl = process.env.DOWNLOAD_PUBLIC_BASE_URL || process.env.ACCESS_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "",
  } = {}) {
    this.cobalt = cobalt;
    this.fetch = fetchImpl;
    this.root = resolvePath(root);
    this.maxBytes = maxBytes;
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.maxQueue = Math.max(1, Math.floor(maxQueue));
    this.cooldownMs = cooldownMs;
    this.linkTtlMs = linkTtlMs;
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, "");
    this.active = new Map();
    this.pending = [];
    this.cooldowns = new Map();
    this.links = new Map();
    mkdirSync(this.root, { recursive: true });
  }

  settings(config = {}) {
    return {
      enabled: Boolean(this.cobalt?.apiUrl),
      apiOrigin: this.cobalt?.apiUrl?.origin || null,
      maxBytes: this.maxBytes,
      concurrency: this.concurrency,
      maxQueue: this.maxQueue,
      cooldownMs: this.cooldownMs,
      linkTtlMs: this.linkTtlMs,
      publicLinks: Boolean(this.publicBaseUrl),
      allowedRoles: config.downloadAllowedRoles ?? ["Ботоводство"],
    };
  }

  status(config = {}, guildId) {
    this.cleanupExpired();
    return {
      settings: this.settings(config),
      queue: [
        ...[...this.active.values()].map((job) => ({ ...job, status: "processing" })),
        ...this.pending.map(({ job }) => ({ ...job, status: "queued" })),
      ].filter((job) => !guildId || job.guildId === guildId),
      history: listDownloadRecords({ guildId, limit: 100 }),
    };
  }

  async run({ guildId, channelId, userId, userTag, sourceUrl }) {
    const now = Date.now();
    const last = this.cooldowns.get(userId) || 0;
    if (now - last < this.cooldownMs) {
      const waitSec = Math.ceil((this.cooldownMs - (now - last)) / 1000);
      throw new Error(`Подождите ${waitSec} сек. перед следующей загрузкой.`);
    }
    if (this.pending.length >= this.maxQueue) throw new Error("Очередь загрузок заполнена. Попробуйте позже.");
    this.cooldowns.set(userId, now);
    const id = randomUUID();
    const job = { id, guildId, channelId, userId, userTag, sourceHost: new URL(sourceUrl).hostname, createdAt: now };
    createDownloadRecord({ ...job, sourceUrl: sanitizeSourceUrl(sourceUrl), status: "queued" });
    return new Promise((resolve, reject) => {
      this.pending.push({ job, sourceUrl, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    while (this.active.size < this.concurrency && this.pending.length) {
      const item = this.pending.shift();
      this.active.set(item.job.id, item.job);
      void this.#execute(item).then(item.resolve, item.reject).finally(() => {
        this.active.delete(item.job.id);
        this.#pump();
      });
    }
  }

  async #execute({ job, sourceUrl }) {
    updateDownloadRecord(job.id, { status: "processing", startedAt: Date.now() });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), positiveNumber(process.env.DOWNLOAD_TIMEOUT_MS, 10 * 60_000));
    let path = null;
    try {
      const resolved = await this.cobalt.resolve(sourceUrl, { signal: controller.signal });
      const resultUrl = this.cobalt.validateResultUrl(resolved.url);
      const response = await this.#fetchResult(resultUrl, controller.signal);
      if (!response.ok || !response.body) throw new Error(`Не удалось получить файл (HTTP ${response.status}).`);
      const announced = Number(response.headers.get("content-length") || response.headers.get("estimated-content-length") || 0);
      if (announced > this.maxBytes) throw new Error(`Файл превышает лимит ${Math.floor(this.maxBytes / 1024 / 1024)} МБ.`);
      const filename = safeFilename(resolved.filename, response.headers.get("content-type"));
      path = resolvePath(this.root, `${job.id}-${filename}`);
      if (!path.startsWith(this.root + sep)) throw new Error("Небезопасное имя файла.");
      mkdirSync(dirname(path), { recursive: true });
      const stream = createWriteStream(path, { flags: "wx" });
      const reader = response.body.getReader();
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.maxBytes) throw new Error(`Файл превышает лимит ${Math.floor(this.maxBytes / 1024 / 1024)} МБ.`);
          if (!stream.write(value)) await once(stream, "drain");
        }
        stream.end();
        await once(stream, "finish");
      } catch (error) {
        stream.destroy();
        throw error;
      }
      const result = { id: job.id, path, filename, size, itemCount: resolved.itemCount || 1 };
      updateDownloadRecord(job.id, { status: "ready", filename, sizeBytes: size, completedAt: Date.now() });
      return result;
    } catch (error) {
      if (path) this.remove(path);
      const message = error?.name === "AbortError" ? "Время загрузки истекло." : error.message;
      updateDownloadRecord(job.id, { status: "error", error: message, completedAt: Date.now() });
      throw new Error(message);
    } finally {
      clearTimeout(timeout);
    }
  }

  async #fetchResult(initialUrl, signal) {
    let current = initialUrl;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await this.fetch(current, { redirect: "manual", signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) throw new Error("Сервис вернул перенаправление без адреса.");
      current = this.cobalt.validateResultUrl(new URL(location, current).toString());
    }
    throw new Error("Слишком много перенаправлений при загрузке файла.");
  }

  createPublicLink(result) {
    if (!this.publicBaseUrl) throw new Error("Публичный адрес для больших файлов не настроен.");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.linkTtlMs;
    this.links.set(token, { ...result, expiresAt });
    updateDownloadRecord(result.id, { status: "linked", expiresAt });
    return { url: `${this.publicBaseUrl}/downloads/${token}/${encodeURIComponent(result.filename)}`, expiresAt };
  }

  takePublicFile(token) {
    this.cleanupExpired();
    return this.links.get(token) || null;
  }

  remove(path) {
    try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") console.warn("[download] cleanup:", error.message); }
  }

  cleanupExpired(now = Date.now()) {
    for (const [token, item] of this.links) {
      if (item.expiresAt <= now) {
        this.links.delete(token);
        this.remove(item.path);
      }
    }
  }
}

export const downloadService = new DownloadService();
