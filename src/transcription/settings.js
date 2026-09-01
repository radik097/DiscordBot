import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_TRANSCRIPTION_PROVIDER,
  normalizeTranscriptionProfile,
  transcriptionCatalog,
} from "./modelCatalog.js";

const DEFAULT_PATH = new URL("../../data/transcription-settings.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DEFAULT_KEY_PATH = new URL("../../data/.transcription-settings.key", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ENV_KEYS = Object.freeze({ openai: "OPENAI_API_KEY", mistral: "MISTRAL_API_KEY" });

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return null;
  return text.length <= 4 ? "••••" : `••••${text.slice(-4)}`;
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch {}
}

export class TranscriptionSettings {
  constructor({ path = DEFAULT_PATH, keyPath = DEFAULT_KEY_PATH, env = process.env } = {}) {
    this.path = resolve(path);
    this.keyPath = resolve(keyPath);
    this.env = env;
    const initialProvider = String(env.TRANSCRIPTION_PROVIDER || DEFAULT_TRANSCRIPTION_PROVIDER).toLowerCase();
    const initialModel = env.TRANSCRIPTION_MODEL
      || (initialProvider === "local" ? env.WHISPER_MODEL || DEFAULT_TRANSCRIPTION_MODEL : undefined);
    const initial = normalizeTranscriptionProfile(initialProvider, initialModel);
    this.state = {
      version: 1,
      provider: initial.provider,
      model: initial.model,
      secrets: {},
    };
    this.#load();
  }

  #load() {
    if (!existsSync(this.path)) return;
    try {
      const stored = JSON.parse(readFileSync(this.path, "utf8"));
      const profile = normalizeTranscriptionProfile(stored.provider, stored.model);
      this.state = { version: 1, ...profile, secrets: stored.secrets && typeof stored.secrets === "object" ? stored.secrets : {} };
      delete this.state.cloud;
    } catch (error) {
      throw new Error(`Настройки транскрипции повреждены: ${error.message}`);
    }
  }

  #key() {
    const configured = String(this.env.TRANSCRIPTION_SETTINGS_SECRET || "").trim();
    if (configured) return createHash("sha256").update(configured).digest();
    mkdirSync(dirname(this.keyPath), { recursive: true });
    if (!existsSync(this.keyPath)) {
      writeFileSync(this.keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
      try { chmodSync(this.keyPath, 0o600); } catch {}
    }
    const key = readFileSync(this.keyPath);
    if (key.length !== 32) throw new Error("Локальный ключ настроек транскрипции имеет неверный формат.");
    return key;
  }

  #encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key(), iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
  }

  #decrypt(record) {
    if (!record?.iv || !record?.tag || !record?.data) return "";
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key(), Buffer.from(record.iv, "base64"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Не удалось расшифровать ключ облачной транскрипции.");
    }
  }

  #savedKey(provider) {
    return this.#decrypt(this.state.secrets[provider]);
  }

  keyStatus(provider) {
    const envName = ENV_KEYS[provider];
    if (!envName) return { configured: true, source: "local", masked: null };
    const saved = this.#savedKey(provider);
    const environment = String(this.env[envName] || "").trim();
    const value = saved || environment;
    return { configured: Boolean(value), source: saved ? "panel" : environment ? "environment" : null, masked: maskSecret(value) };
  }

  view() {
    return {
      provider: this.state.provider,
      model: this.state.model,
      catalog: transcriptionCatalog(),
      keys: { openai: this.keyStatus("openai"), mistral: this.keyStatus("mistral") },
    };
  }

  resolve(provider = this.state.provider, model = this.state.model) {
    const profile = normalizeTranscriptionProfile(provider, model);
    if (!profile.cloud) return profile;
    const apiKey = this.#savedKey(profile.provider) || String(this.env[ENV_KEYS[profile.provider]] || "").trim();
    if (!apiKey) throw new Error(`API-ключ ${profile.provider === "openai" ? "OpenAI" : "Mistral"} не настроен.`);
    return { ...profile, apiKey };
  }

  update({ provider, model, keys = {}, clear = [] } = {}) {
    const profile = normalizeTranscriptionProfile(provider ?? this.state.provider, model ?? this.state.model);
    const secrets = { ...this.state.secrets };
    for (const name of ["openai", "mistral"]) {
      if (Array.isArray(clear) && clear.includes(name)) delete secrets[name];
      const value = typeof keys?.[name] === "string" ? keys[name].trim() : "";
      if (value) {
        if (value.length < 8 || value.length > 4096) throw new Error(`API-ключ ${name} имеет недопустимую длину.`);
        secrets[name] = this.#encrypt(value);
      }
    }
    this.state = { version: 1, provider: profile.provider, model: profile.model, secrets };
    atomicJson(this.path, this.state);
    return this.view();
  }
}

export const transcriptionSettings = new TranscriptionSettings();
