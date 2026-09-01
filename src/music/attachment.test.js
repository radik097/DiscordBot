import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { commands } from "../commands/music.js";
import { getMaxAttachmentBytes, probeMediaFile, resolveAttachment, validateDiscordAttachmentUrl } from "./attachment.js";
import { AUDIO_CACHE_DIR, getAudioStream } from "./source.js";

function wavSilence(durationSec = 0.1) {
  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataBytes = Math.max(2, Math.floor(sampleRate * durationSec) * channels * (bitsPerSample / 8));
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function attachment(overrides = {}) {
  return {
    id: "1234567890",
    name: "sample.MP4",
    url: "https://cdn.discordapp.com/attachments/1/2/sample.mp4?ex=signed",
    size: 1024,
    contentType: "video/mp4",
    ...overrides,
  };
}

describe("Discord media attachments", () => {
  test("accepts only direct HTTPS Discord attachment URLs", () => {
    expect(validateDiscordAttachmentUrl(attachment().url).hostname).toBe("cdn.discordapp.com");
    expect(() => validateDiscordAttachmentUrl("https://example.com/attachments/1/2/file.mp3")).toThrow("непосредственно в Discord");
    expect(() => validateDiscordAttachmentUrl("http://cdn.discordapp.com/attachments/1/2/file.mp3")).toThrow("непосредственно в Discord");
    expect(() => validateDiscordAttachmentUrl("https://cdn.discordapp.com/not-attachments/file.mp3")).toThrow("не является Discord-вложением");
  });

  test("uses a bounded configurable upload limit", () => {
    expect(getMaxAttachmentBytes({})).toBe(200 * 1024 * 1024);
    expect(getMaxAttachmentBytes({ MUSIC_FILE_MAX_BYTES: "4096" })).toBe(4096);
    expect(getMaxAttachmentBytes({ MUSIC_FILE_MAX_BYTES: "invalid" })).toBe(200 * 1024 * 1024);
  });

  test("streams an attachment to cache and returns a persistent file track", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "discordbot-attachment-"));
    const bytes = wavSilence();
    try {
      const resolved = await resolveAttachment(attachment({ name: "clip.WAV", size: bytes.length }), "tester", {
        cacheDir,
        fetchImpl: async () => new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }),
        probeImpl: async () => ({ durationSec: 0.1, audioCodec: "pcm_s16le", format: "wav" }),
      });
      expect(resolved.kind).toBe("file");
      expect(resolved.tracks[0]).toMatchObject({
        sourceType: "attachment",
        title: "clip.WAV",
        durationSec: 0.1,
        requestedBy: "tester",
        sizeBytes: bytes.length,
      });
      expect(resolved.tracks[0].cacheFile).toMatch(/^upload-[a-f0-9]{64}\.wav$/);
      expect(existsSync(path.join(cacheDir, resolved.tracks[0].cacheFile))).toBe(true);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("deduplicates concurrent downloads of the same Discord attachment", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "discordbot-attachment-concurrent-"));
    const bytes = wavSilence();
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(bytes, { status: 200 });
    };
    try {
      const options = { cacheDir, fetchImpl, probeImpl: async () => ({ durationSec: 0.1 }) };
      const [first, second] = await Promise.all([
        resolveAttachment(attachment({ id: "concurrent", size: bytes.length }), "one", options),
        resolveAttachment(attachment({ id: "concurrent", size: bytes.length }), "two", options),
      ]);
      expect(fetches).toBe(1);
      expect(first.tracks[0].cacheFile).toBe(second.tracks[0].cacheFile);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("rejects declared and streamed files above the configured limit", async () => {
    const declaredCacheDir = await mkdtemp(path.join(tmpdir(), "discordbot-oversize-declared-"));
    try {
      await expect(resolveAttachment(attachment({ size: 11 }), "tester", {
        maxBytes: 10,
        cacheDir: declaredCacheDir,
        fetchImpl: async () => { throw new Error("fetch must not run"); },
        probeImpl: async () => ({}),
      })).rejects.toThrow("слишком большой");
    } finally {
      await rm(declaredCacheDir, { recursive: true, force: true });
    }

    const cacheDir = await mkdtemp(path.join(tmpdir(), "discordbot-oversize-stream-"));
    try {
      await expect(resolveAttachment(attachment({ id: "streamed", size: 0 }), "tester", {
        maxBytes: 4,
        cacheDir,
        fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 }),
        probeImpl: async () => ({}),
      })).rejects.toThrow("превысил лимит");
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("ffprobe and FFmpeg accept a cached local audio file", async () => {
    const cacheFile = `upload-${"a".repeat(64)}.wav`;
    const filePath = path.join(AUDIO_CACHE_DIR, cacheFile);
    await writeFile(filePath, wavSilence(0.2));
    let child;
    let stream;
    try {
      const metadata = await probeMediaFile(filePath);
      expect(metadata.durationSec).toBeGreaterThan(0);
      const result = await getAudioStream({ sourceType: "attachment", cacheFile }, "best", 0);
      child = result.process;
      stream = result.stream;
      expect(result.quality).toBe("file");
      expect(result.stats.bytesOut).toBeGreaterThan(0);
    } finally {
      stream?.destroy();
      if (child && !child.killed) child.kill("SIGTERM");
      await rm(filePath, { force: true });
    }
  });

  test("FFmpeg plays a cached Cobalt audio source", async () => {
    const cacheFile = `cobalt-${"e".repeat(64)}.wav`;
    const filePath = path.join(AUDIO_CACHE_DIR, cacheFile);
    await writeFile(filePath, wavSilence(0.2));
    let child;
    let stream;
    try {
      const result = await getAudioStream({ sourceType: "cobalt", cacheFile }, "best", 0);
      child = result.process;
      stream = result.stream;
      expect(result.quality).toBe("file");
      expect(result.stats.bytesOut).toBeGreaterThan(0);
    } finally {
      stream?.destroy();
      if (child && !child.killed) child.kill("SIGTERM");
      await rm(filePath, { force: true });
    }
  });

  test("extracts the audio track from a video container", async () => {
    const cacheFile = `upload-${"b".repeat(64)}.mp4`;
    const filePath = path.join(AUDIO_CACHE_DIR, cacheFile);
    const generated = spawnSync(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.25",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.25",
      "-shortest", "-c:v", "mpeg4", "-c:a", "aac", filePath,
    ]);
    expect(generated.status).toBe(0);

    let child;
    let stream;
    try {
      const metadata = await probeMediaFile(filePath);
      expect(metadata.durationSec).toBeGreaterThan(0);
      const result = await getAudioStream({ sourceType: "attachment", cacheFile }, "best", 0);
      child = result.process;
      stream = result.stream;
      expect(result.quality).toBe("file");
      expect(result.stats.bytesOut).toBeGreaterThan(0);
    } finally {
      stream?.destroy();
      if (child && !child.killed) child.kill("SIGTERM");
      await rm(filePath, { force: true });
    }
  });

  test("rejects video containers without an audio track", async () => {
    const filePath = path.join(AUDIO_CACHE_DIR, `upload-${"d".repeat(64)}.mp4`);
    const generated = spawnSync(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.1",
      "-c:v", "mpeg4", "-an", filePath,
    ]);
    expect(generated.status).toBe(0);
    try {
      await expect(probeMediaFile(filePath)).rejects.toThrow("не содержит аудиодорожку");
    } finally {
      await rm(filePath, { force: true });
    }
  });

  test("/play exposes separate mutually optional track, playlist, and attachment inputs", () => {
    const play = commands.find((command) => command.data.name === "play").data.toJSON();
    expect(play.options.map((option) => ({ name: option.name, required: option.required ?? false }))).toEqual([
      { name: "query", required: false },
      { name: "playlist", required: false },
      { name: "file", required: false },
    ]);
  });
});
