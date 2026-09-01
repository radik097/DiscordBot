import { validatePublicMediaUrl } from "../downloads/cobalt.js";

const SPOTIFY_HOSTS = new Set(["open.spotify.com", "spotify.link"]);

export function isSpotifyUrl(value) {
  try {
    return SPOTIFY_HOSTS.has(validatePublicMediaUrl(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function assertSingleTrack(url, payload = null) {
  if (url.hostname.toLowerCase() === "open.spotify.com" && !/^\/track\/[A-Za-z0-9]{22}\/?$/.test(url.pathname)) {
    throw new Error("Для Spotify укажите ссылку на один трек, а не альбом или плейлист.");
  }
  if (payload && !/\/embed\/track\//i.test(String(payload.html || ""))) {
    throw new Error("Для Spotify укажите ссылку на один трек, а не альбом или плейлист.");
  }
}

export async function resolveSpotifyTrack(value, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Получение данных Spotify недоступно в текущем runtime.");
  const source = validatePublicMediaUrl(value);
  if (!SPOTIFY_HOSTS.has(source.hostname.toLowerCase())) throw new Error("Укажите корректную ссылку Spotify.");
  assertSingleTrack(source);

  const endpoint = new URL("https://open.spotify.com/oembed");
  endpoint.searchParams.set("url", source.toString());
  let response;
  try {
    response = await fetchImpl(endpoint, { headers: { accept: "application/json" } });
  } catch {
    throw new Error("Не удалось получить название трека из Spotify.");
  }
  if (response.status === 404) throw new Error("Spotify не нашёл этот трек.");
  if (!response.ok) throw new Error(`Spotify не отдал данные трека (HTTP ${response.status}).`);
  const payload = await response.json().catch(() => null);
  if (!payload?.title) throw new Error("Spotify вернул данные без названия трека.");
  assertSingleTrack(source, payload);
  return {
    title: String(payload.title).trim().slice(0, 200),
    thumbnail: payload.thumbnail_url || null,
    sourceUrl: source.toString(),
  };
}
