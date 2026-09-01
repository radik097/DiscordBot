import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DownloadService, normalizeDownloadOptions } from "./service.js";

async function eventually(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Условие не выполнено вовремя");
}

describe("website video downloads", () => {
  test("normalizes video and audio options for Cobalt", () => {
    expect(normalizeDownloadOptions({ format: "video", quality: "1080" })).toMatchObject({
      format: "video",
      quality: "1080",
      cobalt: { downloadMode: "auto", videoQuality: "1080", youtubeVideoCodec: "h264", youtubeVideoContainer: "mp4" },
    });
    expect(normalizeDownloadOptions({ format: "audio", quality: "720" })).toMatchObject({
      format: "audio",
      cobalt: { downloadMode: "audio", audioFormat: "best" },
    });
    expect(() => normalizeDownloadOptions({ format: "archive" })).toThrow("video или audio");
  });

  test("queues a web video and publishes a temporary result link", async () => {
    const root = await mkdtemp(join(tmpdir(), "discord-video-download-"));
    let cobaltOptions;
    const cobalt = {
      apiUrl: new URL("http://cobalt:9000/"),
      resolve: async (_url, options) => {
        cobaltOptions = options;
        return { url: "https://cdn.example.com/video.mp4", filename: "video.mp4", itemCount: 1 };
      },
      validateResultUrl: (value) => new URL(value),
    };
    const service = new DownloadService({
      cobalt,
      root,
      cooldownMs: 1,
      publicBaseUrl: "https://panel.example",
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "video/mp4", "content-length": "4" },
      }),
    });
    const guildId = `guild-${crypto.randomUUID()}`;
    try {
      const queued = service.startPublic({
        guildId,
        userId: crypto.randomUUID(),
        userTag: "Веб-панель",
        sourceUrl: "https://youtube.com/watch?v=example",
        format: "video",
        quality: "1080",
      });
      expect(queued.id).toBeString();
      const ready = await eventually(() => service.status({}, guildId).available[0]);
      expect(ready.url).toContain("https://panel.example/downloads/");
      expect(ready.filename).toBe("video.mp4");
      expect(cobaltOptions).toMatchObject({
        downloadMode: "auto",
        videoQuality: "1080",
        youtubeVideoCodec: "h264",
        youtubeVideoContainer: "mp4",
      });
      service.cleanupExpired(ready.expiresAt + 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
