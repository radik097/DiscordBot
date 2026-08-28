import { describe, expect, test } from "bun:test";
import { CobaltClient, CobaltError, sanitizeSourceUrl, validatePublicMediaUrl } from "./cobalt.js";

describe("CobaltClient", () => {
  test("rejects local, credentialed and non-http source URLs", () => {
    for (const value of ["file:///etc/passwd", "http://localhost/a", "http://127.0.0.1/a", "https://user:pass@example.com/a"]) {
      expect(() => validatePublicMediaUrl(value)).toThrow();
    }
    expect(validatePublicMediaUrl("https://www.youtube.com/watch?v=abc").hostname).toBe("www.youtube.com");
  });

  test("removes query and fragment before history storage", () => {
    expect(sanitizeSourceUrl("https://example.com/media/video?id=secret#part")).toBe("https://example.com/media/video");
  });

  test("posts the documented proxy request and handles tunnel", async () => {
    let request;
    const client = new CobaltClient({
      apiUrl: "http://cobalt:9000/",
      apiKey: "test-key",
      fetchImpl: async (url, options) => {
        request = { url: String(url), options };
        return Response.json({ status: "tunnel", url: "http://cobalt:9000/tunnel/abc", filename: "clip.mp4" });
      },
    });
    expect(await client.resolve("https://youtube.com/watch?v=abc")).toEqual({ status: "tunnel", url: "http://cobalt:9000/tunnel/abc", filename: "clip.mp4" });
    expect(request.options.headers.authorization).toBe("Api-Key test-key");
    expect(JSON.parse(request.options.body)).toMatchObject({ alwaysProxy: true, downloadMode: "auto" });
  });

  test("requests audio mode and prefers picker background audio", async () => {
    let body;
    const client = new CobaltClient({
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return Response.json({
          status: "picker",
          audio: "https://cdn.example.com/audio.opus",
          audioFilename: "artist - title.opus",
          picker: [{ type: "photo", url: "https://cdn.example.com/photo.jpg" }],
        });
      },
    });
    expect(await client.resolve("https://tiktok.com/example", { downloadMode: "audio", audioFormat: "best" }))
      .toMatchObject({ url: "https://cdn.example.com/audio.opus", filename: "artist - title.opus" });
    expect(body).toMatchObject({ downloadMode: "audio", audioFormat: "best", localProcessing: "disabled", alwaysProxy: true });
  });

  test("selects the first playable picker item", async () => {
    const client = new CobaltClient({
      fetchImpl: async () => Response.json({ status: "picker", picker: [{ type: "photo", url: "https://cdn.example.com/1.jpg" }, { type: "video", url: "https://cdn.example.com/2.mp4" }] }),
    });
    expect(await client.resolve("https://instagram.com/p/example")).toMatchObject({ status: "picker", url: "https://cdn.example.com/2.mp4", itemCount: 2 });
  });

  test("maps Cobalt error responses", async () => {
    const client = new CobaltClient({ fetchImpl: async () => Response.json({ status: "error", error: { code: "error.api.link.unsupported" } }) });
    await expect(client.resolve("https://example.com/video")).rejects.toBeInstanceOf(CobaltError);
  });
});
