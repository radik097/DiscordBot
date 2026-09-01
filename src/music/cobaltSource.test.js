import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getMaxCobaltMusicBytes, isCobaltMusicUrl, resolveCobaltTrack } from "./cobaltSource.js";

function client(resolveImpl) {
  return {
    resolve: resolveImpl,
    validateResultUrl: (value) => new URL(value),
  };
}

describe("Cobalt music source", () => {
  test("routes public non-YouTube URLs only", () => {
    expect(isCobaltMusicUrl("https://soundcloud.com/artist/track")).toBe(true);
    expect(isCobaltMusicUrl("https://www.instagram.com/reel/example/")).toBe(true);
    expect(isCobaltMusicUrl("https://youtu.be/5M9zMQXItqM")).toBe(false);
    expect(isCobaltMusicUrl("http://127.0.0.1/audio")).toBe(false);
    expect(isCobaltMusicUrl("not a url")).toBe(false);
  });

  test("uses the configured bounded file limit", () => {
    expect(getMaxCobaltMusicBytes({})).toBe(200 * 1024 * 1024);
    expect(getMaxCobaltMusicBytes({ COBALT_MUSIC_MAX_BYTES: "4096" })).toBe(4096);
    expect(getMaxCobaltMusicBytes({ COBALT_MUSIC_MAX_BYTES: "bad", MUSIC_FILE_MAX_BYTES: "2048" })).toBe(2048);
  });

  test("downloads once, probes audio and returns a persistent local track", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "discordbot-cobalt-music-"));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    let resolves = 0;
    let fetches = 0;
    const cobalt = client(async (_url, options) => {
      resolves += 1;
      expect(options).toMatchObject({ downloadMode: "audio", audioFormat: "best", localProcessing: "disabled" });
      return { status: "tunnel", url: "http://cobalt:9000/tunnel/test", filename: "Artist - Track.opus" };
    });
    const options = {
      client: cobalt,
      cacheDir,
      fetchImpl: async () => {
        fetches += 1;
        return new Response(bytes, { headers: { "content-type": "audio/opus", "content-length": String(bytes.length) } });
      },
      probeImpl: async () => ({ durationSec: 123, audioCodec: "opus" }),
      pruneImpl: async () => {},
    };
    try {
      const [first, second] = await Promise.all([
        resolveCobaltTrack("https://soundcloud.com/artist/track?token=secret", "one", options),
        resolveCobaltTrack("https://soundcloud.com/artist/track?token=secret", "two", options),
      ]);
      expect(resolves).toBe(1);
      expect(fetches).toBe(1);
      expect(first).toMatchObject({
        sourceType: "cobalt",
        title: "Artist Track",
        durationSec: 123,
        requestedBy: "one",
        sizeBytes: 4,
        sourceService: "soundcloud.com",
        url: "https://soundcloud.com/artist/track",
      });
      expect(second.cacheFile).toBe(first.cacheFile);
      expect(second.requestedBy).toBe("two");
      expect(await readdir(cacheDir)).toEqual([first.cacheFile]);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("removes a downloaded file when it has no audio track", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "discordbot-cobalt-no-audio-"));
    try {
      await expect(resolveCobaltTrack("https://x.com/example/status/1", "tester", {
        client: client(async () => ({ status: "tunnel", url: "http://cobalt:9000/tunnel/video", filename: "video.mp4" })),
        cacheDir,
        fetchImpl: async () => new Response(new Uint8Array([1, 2, 3])),
        probeImpl: async () => { throw new Error("Файл не содержит аудиодорожку"); },
        pruneImpl: async () => {},
      })).rejects.toThrow("не содержит аудиодорожку");
      expect(await readdir(cacheDir)).toEqual([]);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
