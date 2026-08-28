import { isIP } from "node:net";

const PRIVATE_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);

function isPrivateIp(hostname) {
  const version = isIP(hostname);
  if (version === 4) {
    const [a, b] = hostname.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (version === 6) {
    const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") ||
      value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
  }
  return false;
}

export function validatePublicMediaUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new Error("Укажите корректную HTTP(S)-ссылку.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Разрешены только HTTP(S)-ссылки.");
  if (url.username || url.password) throw new Error("Ссылки со встроенными учётными данными запрещены.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || PRIVATE_HOSTS.has(hostname) || hostname.endsWith(".localhost") || isPrivateIp(hostname)) {
    throw new Error("Локальные и служебные адреса запрещены.");
  }
  return url;
}

export function sanitizeSourceUrl(value) {
  const url = validatePublicMediaUrl(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export class CobaltError extends Error {
  constructor(message, code = "cobalt.error") {
    super(message);
    this.name = "CobaltError";
    this.code = code;
  }
}

export class CobaltClient {
  constructor({ apiUrl = process.env.COBALT_API_URL || "http://cobalt:9000/", apiKey = process.env.COBALT_API_KEY || "", fetchImpl = fetch } = {}) {
    this.apiUrl = new URL(apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async resolve(sourceUrl, { signal, downloadMode = "auto", audioFormat, localProcessing = "disabled" } = {}) {
    const source = validatePublicMediaUrl(sourceUrl);
    const headers = { accept: "application/json", "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Api-Key ${this.apiKey}`;
    const response = await this.fetch(this.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: source.toString(),
        downloadMode,
        ...(audioFormat ? { audioFormat } : {}),
        filenameStyle: "basic",
        alwaysProxy: true,
        localProcessing,
      }),
      signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      throw new CobaltError(`Cobalt API недоступен (HTTP ${response.status}).`, "cobalt.http");
    }
    if (payload.status === "error") {
      throw new CobaltError(payload.error?.context?.service || payload.error?.code || "Cobalt не смог обработать ссылку.", payload.error?.code);
    }
    if (["tunnel", "redirect", "local-processing"].includes(payload.status) && payload.url) {
      return { status: payload.status, url: payload.url, filename: payload.filename || "download" };
    }
    if (payload.status === "picker" && downloadMode === "audio" && payload.audio) {
      return { status: "picker", url: payload.audio, filename: payload.audioFilename || payload.filename || "audio", itemCount: payload.picker?.length || 1 };
    }
    if (payload.status === "picker" && Array.isArray(payload.picker) && payload.picker.length) {
      const selected = payload.picker.find((item) => item?.type === "video") ||
        payload.picker.find((item) => item?.type === "audio") || payload.picker.find((item) => item?.url);
      if (selected?.url) {
        return { status: "picker", url: selected.url, filename: payload.filename || "download", itemCount: payload.picker.length };
      }
    }
    throw new CobaltError("Cobalt вернул неподдерживаемый ответ.", "cobalt.unsupported_response");
  }

  validateResultUrl(value) {
    const url = new URL(value, this.apiUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new CobaltError("Cobalt вернул небезопасный адрес.");
    if (url.origin !== this.apiUrl.origin) validatePublicMediaUrl(url);
    return url;
  }
}
