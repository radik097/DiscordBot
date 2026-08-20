const DEPLOYMENT_MODES = new Set(["local", "server"]);
const REMOTE_PROVIDERS = new Set(["auto", "ngrok", "cloudflare", "disabled"]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalizePublicBaseUrl(value) {
  const raw = clean(value);
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("PUBLIC_BASE_URL должен быть корректным URL, например https://panel.example.com");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL должен использовать HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("PUBLIC_BASE_URL не должен содержать логин, query-параметры или fragment");
  }
  return parsed.origin;
}

export function resolveRuntimeConfig(env = process.env, overrides = {}) {
  const deploymentMode = clean(overrides.deploymentMode ?? env.DEPLOYMENT_MODE ?? "local").toLowerCase();
  if (!DEPLOYMENT_MODES.has(deploymentMode)) {
    throw new Error(`DEPLOYMENT_MODE должен быть local или server, получено: ${deploymentMode || "пусто"}`);
  }

  const requestedProvider = clean(overrides.remoteProvider ?? env.REMOTE_ACCESS_PROVIDER ?? "auto").toLowerCase();
  if (!REMOTE_PROVIDERS.has(requestedProvider)) {
    throw new Error(`REMOTE_ACCESS_PROVIDER должен быть auto, ngrok, cloudflare или disabled, получено: ${requestedProvider || "пусто"}`);
  }

  const remoteProvider = requestedProvider === "auto"
    ? deploymentMode === "server" ? "cloudflare" : "ngrok"
    : requestedProvider;
  const publicBaseUrl = normalizePublicBaseUrl(overrides.publicBaseUrl ?? env.PUBLIC_BASE_URL);

  if (remoteProvider === "cloudflare" && !publicBaseUrl) {
    throw new Error("Для Cloudflare-режима задайте PUBLIC_BASE_URL=https://panel.example.com в .env");
  }

  return {
    deploymentMode,
    remoteProvider,
    publicBaseUrl,
  };
}
