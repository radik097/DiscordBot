import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { PcmVolumeTransformer, scalePcm16le } from "./pcmVolume.js";

function pcm(...samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

function samples(buffer) {
  const result = [];
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) result.push(buffer.readInt16LE(offset));
  return result;
}

describe("real PCM volume transformer", () => {
  test("scales and clamps signed 16-bit audio", () => {
    expect(samples(scalePcm16le(pcm(1000, -1000, 20000, -20000), 0.5))).toEqual([500, -500, 10000, -10000]);
    expect(samples(scalePcm16le(pcm(20000, -20000), 2))).toEqual([32767, -32768]);
    expect(samples(scalePcm16le(pcm(1234, -1234), 0))).toEqual([0, 0]);
  });

  test("changes gain while the same stream is playing", async () => {
    const transformer = new PcmVolumeTransformer(1);
    const chunks = [];
    transformer.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    await new Promise((resolve, reject) => transformer.write(pcm(1000, -1000), (error) => error ? reject(error) : resolve()));
    transformer.setVolume(0.25);
    transformer.end(pcm(1000, -1000));
    await once(transformer, "end");
    expect(samples(Buffer.concat(chunks))).toEqual([1000, -1000, 250, -250]);
  });

  test("preserves sample alignment across odd stream chunks", async () => {
    const transformer = new PcmVolumeTransformer(0.5);
    const chunks = [];
    transformer.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const input = pcm(1000, -2000);
    transformer.write(input.subarray(0, 3));
    transformer.end(input.subarray(3));
    await once(transformer, "end");
    expect(samples(Buffer.concat(chunks))).toEqual([500, -1000]);
  });
});
