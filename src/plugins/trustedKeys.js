import { readFile } from "node:fs/promises";

export async function loadTrustedPluginKeys({
  filePath = process.env.PLUGIN_TRUSTED_KEYS_FILE || new URL("../../config/plugin-trusted-keys.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  allowMissing = true,
} = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return {};
    throw new Error(`Не удалось прочитать trusted plugin keys: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Trusted plugin keys должны быть JSON-объектом keyId -> PEM");
  }
  const entries = Object.entries(parsed);
  if (entries.length > 128) throw new Error("Слишком много trusted plugin keys");
  for (const [keyId, pem] of entries) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(keyId) || typeof pem !== "string" || !pem.includes("BEGIN PUBLIC KEY")) {
      throw new Error(`Некорректный trusted plugin key: ${keyId}`);
    }
  }
  return Object.fromEntries(entries);
}
