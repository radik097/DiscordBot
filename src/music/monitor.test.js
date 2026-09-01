import { afterEach, describe, expect, test } from "bun:test";
import ffmpegPath from "ffmpeg-static";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { AUDIO_CACHE_DIR } from "./source.js";
import {
  clearPreparedMusicMonitor,
  getPreparedMusicMonitor,
  prepareMusicMonitorTrack,
  startMusicMonitor,
  stopMusicMonitor,
} from "./monitor.js";

const files = [];
const keys = [];

afterEach(async () => {
  for (const key of keys.splice(0)) clearPreparedMusicMonitor(key);
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })));
});

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function pcmRms(mp3) {
  const decoded = spawnSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-f", "mp3", "-i", "pipe:0",
    "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1",
  ], { input: mp3 });
  expect(decoded.status).toBe(0);
  let squares = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < decoded.stdout.length; offset += 2) {
    const sample = decoded.stdout.readInt16LE(offset);
    squares += sample * sample;
    samples += 1;
  }
  return Math.sqrt(squares / Math.max(1, samples));
}

async function fixture() {
  const file = path.join(AUDIO_CACHE_DIR, `monitor-test-${randomUUID()}.wav`);
  files.push(file);
  const generated = spawnSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "0.35", "-ac", "2", file,
  ]);
  expect(generated.status).toBe(0);
  return file;
}

describe("browser music monitor", () => {
  test("streams the cached track with the selected server gain", async () => {
    const file = await fixture();
    const loudKey = randomUUID();
    const mutedKey = randomUUID();
    keys.push(loudKey, mutedKey);
    const loud = await startMusicMonitor({ key: loudKey, file, volume: 1 });
    const muted = await startMusicMonitor({ key: mutedKey, file, volume: 0 });
    const loudRms = pcmRms(await collect(loud.stream));
    const mutedRms = pcmRms(await collect(muted.stream));
    expect(loudRms).toBeGreaterThan(1000);
    expect(mutedRms).toBe(0);
  });

  test("never serves a path outside the managed audio cache", async () => {
    await expect(startMusicMonitor({ key: randomUUID(), file: path.join(AUDIO_CACHE_DIR, "..", "secret.txt") }))
      .rejects.toThrow("вне аудиокэша");
  });

  test("prepares one opaque browser source without exposing its cache path", async () => {
    const key = randomUUID();
    keys.push(key);
    const hash = randomBytes(32).toString("hex");
    const regularFixture = await fixture();
    const cacheFile = `upload-${hash}.wav`;
    const attachmentFile = path.join(AUDIO_CACHE_DIR, cacheFile);
    files.push(attachmentFile);
    const copied = spawnSync(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-i", regularFixture, "-c:a", "pcm_s16le", attachmentFile,
    ]);
    expect(copied.status).toBe(0);

    const result = await prepareMusicMonitorTrack({
      key,
      track: {
        title: "Локальный тест",
        url: "https://cdn.discordapp.com/attachments/1/2/test.wav",
        sourceType: "attachment",
        cacheFile,
      },
    });

    expect(result.sourceId).toBeString();
    expect(result).not.toHaveProperty("file");
    expect(getPreparedMusicMonitor(key, result.sourceId)?.file).toBe(attachmentFile);
    expect(getPreparedMusicMonitor(key, randomUUID())).toBeNull();
  });
});
