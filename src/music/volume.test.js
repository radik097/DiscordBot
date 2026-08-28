import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { createAudioResource, StreamType } from "@discordjs/voice";
import opus from "@discordjs/opus";
import {
  getDefaultMusicVolumeRatio,
  getQueue,
  normalizeVolumeRatio,
  volumePercentToRatio,
} from "./queue.js";

const queues = [];

afterEach(() => {
  for (const queue of queues.splice(0)) queue.destroy();
});

describe("host-side music volume", () => {
  test("normalizes percentages and preserves an explicit zero", () => {
    expect(volumePercentToRatio(0)).toBe(0);
    expect(volumePercentToRatio(85)).toBe(0.85);
    expect(volumePercentToRatio(250)).toBe(2);
    expect(volumePercentToRatio(undefined)).toBeNull();
    expect(normalizeVolumeRatio(Number.NaN)).toBeNull();
  });

  test("reads the default host volume from the environment", () => {
    expect(getDefaultMusicVolumeRatio({ MUSIC_DEFAULT_VOLUME_PERCENT: "65" })).toBe(0.65);
    expect(getDefaultMusicVolumeRatio({ MUSIC_DEFAULT_VOLUME_PERCENT: "invalid" })).toBe(1);
  });

  test("applies the new level to the active Discord Voice resource", () => {
    const queue = getQueue(`volume-test-${Date.now()}`);
    queues.push(queue);
    let applied = null;
    queue.currentResource = { volume: { setVolume: (value) => { applied = value; } } };

    expect(queue.setVolume(0)).toBe(0);
    expect(queue.volume).toBe(0);
    expect(applied).toBe(0);

    expect(queue.setVolume(1.35)).toBe(1.35);
    expect(queue.volume).toBe(1.35);
    expect(applied).toBe(1.35);
    expect(() => queue.setVolume(Number.NaN)).toThrow("Громкость");
  });

  test("mutes PCM bytes inside the real inline Discord Voice resource", async () => {
    const input = new PassThrough();
    const resource = createAudioResource(input, { inputType: StreamType.Raw, inlineVolume: true });
    const chunks = [];
    resource.volume.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    resource.volume.setVolume(0);
    const frame = Buffer.alloc(3840);
    for (let offset = 0; offset < frame.length; offset += 2) frame.writeInt16LE(12000, offset);
    input.end(frame);
    await once(resource.volume, "end");
    const output = Buffer.concat(chunks);
    expect(output.length).toBe(frame.length);
    for (let offset = 0; offset < output.length; offset += 2) expect(output.readInt16LE(offset)).toBe(0);
  });

  test("changes decoded amplitude after the complete PCM to Opus pipeline", async () => {
    const { OpusEncoder } = opus;
    async function decodedRms(volume) {
      const pcm = Buffer.alloc(960 * 2 * 2 * 8);
      for (let frame = 0; frame < pcm.length / 4; frame += 1) {
        const sample = Math.round(Math.sin(frame * 2 * Math.PI * 440 / 48000) * 12000);
        pcm.writeInt16LE(sample, frame * 4);
        pcm.writeInt16LE(sample, frame * 4 + 2);
      }
      const resource = createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw, inlineVolume: true });
      resource.volume.setVolume(volume);
      const decoder = new OpusEncoder(48000, 2);
      let squares = 0;
      let samples = 0;
      for await (const packet of resource.playStream) {
        const decoded = decoder.decode(packet);
        for (let offset = 0; offset + 1 < decoded.length; offset += 2) {
          const sample = decoded.readInt16LE(offset);
          squares += sample * sample;
          samples += 1;
        }
      }
      return Math.sqrt(squares / Math.max(1, samples));
    }

    const full = await decodedRms(1);
    const quiet = await decodedRms(0.1);
    const muted = await decodedRms(0);
    expect(full).toBeGreaterThan(7000);
    expect(quiet).toBeGreaterThan(500);
    expect(quiet).toBeLessThan(full * 0.15);
    expect(muted).toBe(0);
  });
});
