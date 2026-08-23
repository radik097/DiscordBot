import { createPublicKey, verify } from "node:crypto";
import path from "node:path";

export const PLUGIN_API_VERSION = "1";
export const PLUGIN_RUNTIMES = new Set(["wasi", "trusted-js"]);
export const PLUGIN_PERMISSIONS = new Set([
  "ai.invoke",
  "discord.commands",
  "discord.events",
  "http.routes",
  "jobs.schedule",
  "mcp.tools",
  "network.egress",
  "storage.kv",
  "ui.trusted",
]);

const LIST_FIELDS = ["permissions", "commands", "events", "routes", "jobs", "tools"];

export class PluginValidationError extends Error {
  constructor(message, code = "INVALID_MANIFEST") {
    super(message);
    this.name = "PluginValidationError";
    this.code = code;
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginValidationError(`${label} должен быть объектом`);
  }
}

export function normalizePluginPath(value, label = "path") {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    throw new PluginValidationError(`${label} должен быть непустым POSIX-путём`);
  }
  if (path.posix.isAbsolute(value)) {
    throw new PluginValidationError(`${label} не может быть абсолютным`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new PluginValidationError(`${label} выходит за пределы пакета`, "PATH_TRAVERSAL");
  }
  return normalized;
}

function normalizeList(value, field) {
  if (!Array.isArray(value) || value.length > 128) {
    throw new PluginValidationError(`${field} должен быть массивом не более 128 элементов`);
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 120) {
      throw new PluginValidationError(`${field} содержит некорректное значение`);
    }
    return item.trim();
  });
  if (new Set(result).size !== result.length) {
    throw new PluginValidationError(`${field} содержит дубликаты`);
  }
  return result;
}

function normalizeHashes(value) {
  assertPlainObject(value, "hashes");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 512) {
    throw new PluginValidationError("hashes должен содержать от 1 до 512 файлов");
  }
  return Object.fromEntries(entries.map(([file, digest]) => {
    const safeFile = normalizePluginPath(file, `hashes.${file}`);
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest)) {
      throw new PluginValidationError(`hashes.${file} должен быть SHA-256 в hex`);
    }
    return [safeFile, digest.toLowerCase()];
  }));
}

function normalizeSignature(value, runtime, permissions) {
  if (value === null || value === undefined) {
    if (runtime === "trusted-js" || permissions.includes("ui.trusted")) {
      throw new PluginValidationError("trusted-js и trusted UI требуют Ed25519-подпись", "SIGNATURE_REQUIRED");
    }
    return null;
  }
  assertPlainObject(value, "signature");
  if (value.algorithm !== "Ed25519" || typeof value.keyId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(value.keyId)) {
    throw new PluginValidationError("signature должна содержать algorithm=Ed25519 и безопасный keyId");
  }
  if (typeof value.value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.value)) {
    throw new PluginValidationError("signature.value должен быть base64");
  }
  return { algorithm: "Ed25519", keyId: value.keyId, value: value.value };
}

export function validatePluginManifest(input, { apiVersion = PLUGIN_API_VERSION } = {}) {
  assertPlainObject(input, "plugin.json");
  if (typeof input.id !== "string" || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(input.id)) {
    throw new PluginValidationError("id должен быть lowercase идентификатором");
  }
  if (typeof input.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) {
    throw new PluginValidationError("version должен быть SemVer");
  }
  if (input.apiVersion !== apiVersion) {
    throw new PluginValidationError(`Неподдерживаемый apiVersion: ${input.apiVersion}`, "API_VERSION_UNSUPPORTED");
  }
  if (!PLUGIN_RUNTIMES.has(input.runtime)) {
    throw new PluginValidationError("runtime должен быть wasi или trusted-js");
  }

  const entry = normalizePluginPath(input.entry, "entry");
  if (input.runtime === "wasi" && path.posix.extname(entry) !== ".wasm") {
    throw new PluginValidationError("WASI entry должен иметь расширение .wasm");
  }
  if (input.runtime === "trusted-js" && ![".js", ".mjs"].includes(path.posix.extname(entry))) {
    throw new PluginValidationError("trusted-js entry должен иметь расширение .js или .mjs");
  }

  const normalized = { id: input.id, version: input.version, apiVersion: input.apiVersion, runtime: input.runtime, entry };
  for (const field of LIST_FIELDS) normalized[field] = normalizeList(input[field], field);
  for (const permission of normalized.permissions) {
    if (!PLUGIN_PERMISSIONS.has(permission)) {
      throw new PluginValidationError(`Неизвестное permission: ${permission}`, "PERMISSION_UNKNOWN");
    }
  }
  if (input.ui !== null && input.ui !== undefined) {
    assertPlainObject(input.ui, "ui");
    normalized.ui = { entry: normalizePluginPath(input.ui.entry, "ui.entry") };
    if (!normalized.permissions.includes("ui.trusted")) {
      throw new PluginValidationError("ui требует permission ui.trusted");
    }
  } else {
    normalized.ui = null;
  }
  normalized.hashes = normalizeHashes(input.hashes);
  if (!normalized.hashes[entry]) throw new PluginValidationError("hashes должен содержать entry");
  if (normalized.ui && !normalized.hashes[normalized.ui.entry]) throw new PluginValidationError("hashes должен содержать ui.entry");
  normalized.signature = normalizeSignature(input.signature, input.runtime, normalized.permissions);
  return normalized;
}

function sortForSignature(value) {
  if (Array.isArray(value)) return value.map(sortForSignature);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortForSignature(value[key])]));
}

export function canonicalManifestPayload(manifest) {
  const { signature: _signature, ...unsigned } = manifest;
  return Buffer.from(JSON.stringify(sortForSignature(unsigned)), "utf8");
}

export function verifyPluginSignature(manifest, publicKeys = {}) {
  if (!manifest.signature) return { verified: false, keyId: null, reason: "unsigned" };
  const key = publicKeys[manifest.signature.keyId];
  if (!key) throw new PluginValidationError(`Неизвестный signing key: ${manifest.signature.keyId}`, "SIGNING_KEY_UNKNOWN");
  let verified = false;
  try {
    verified = verify(
      null,
      canonicalManifestPayload(manifest),
      createPublicKey(key),
      Buffer.from(manifest.signature.value, "base64")
    );
  } catch {
    throw new PluginValidationError("Некорректный Ed25519 public key или signature", "SIGNATURE_INVALID");
  }
  if (!verified) throw new PluginValidationError("Ed25519-подпись не прошла проверку", "SIGNATURE_INVALID");
  return { verified: true, keyId: manifest.signature.keyId, reason: null };
}
