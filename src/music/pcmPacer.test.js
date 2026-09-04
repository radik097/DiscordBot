import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createRealtimePcmPacer, PCM_FRAME_BYTES } from "./pcmPacer.js";

function collect(stream) {
  const frames = [];
  stream.on("data", (chunk) => frames.push(Buffer.from(chunk)));
  return frames;
}

describe("realtime PCM pacing", () => {
  test("releases exactly one audio frame per tick after prebuffering", () => {
    const pacer = createRealtimePcmPacer({ prebufferMs: 40, autoSchedule: false });
    pacer.write(Buffer.alloc(PCM_FRAME_BYTES * 3, 0x31));

    expect(pacer.tick()).toBeTrue();
    const first = pacer.read();
    expect(pacer.tick()).toBeTrue();
    const second = pacer.read();
    expect(first.equals(Buffer.alloc(PCM_FRAME_BYTES, 0x31))).toBeTrue();
    expect(second.equals(Buffer.alloc(PCM_FRAME_BYTES, 0x31))).toBeTrue();
    pacer.destroy();
  });

  test("inserts silence during an underrun and never bursts resumed audio", () => {
    const pacer = createRealtimePcmPacer({ prebufferMs: 20, autoSchedule: false });
    pacer.write(Buffer.alloc(PCM_FRAME_BYTES, 0x42));

    pacer.tick();
    const first = pacer.read();
    pacer.tick();
    const silence = pacer.read();
    expect(first.equals(Buffer.alloc(PCM_FRAME_BYTES, 0x42))).toBeTrue();
    expect(silence.equals(Buffer.alloc(PCM_FRAME_BYTES))).toBeTrue();

    pacer.write(Buffer.alloc(PCM_FRAME_BYTES * 2, 0x63));
    pacer.tick();
    const resumed = pacer.read();
    expect(resumed.equals(Buffer.alloc(PCM_FRAME_BYTES, 0x63))).toBeTrue();
    expect(pacer.stats.underruns).toBe(1);
    pacer.destroy();
  });

  test("corrects normal timer drift but resets after a missed frame", () => {
    let now = 1_000;
    const scheduled = [];
    const pacer = createRealtimePcmPacer({
      prebufferMs: 20,
      now: () => now,
      schedule(callback, delay) {
        scheduled.push({ callback, delay });
        return callback;
      },
      cancel() {},
    });
    pacer.write(Buffer.alloc(PCM_FRAME_BYTES * 4, 0x74));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delay).toBe(20);

    now = 1_022;
    scheduled.shift().callback();
    expect(pacer.read().equals(Buffer.alloc(PCM_FRAME_BYTES, 0x74))).toBeTrue();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delay).toBe(18);

    now = 1_122;
    scheduled.shift().callback();
    expect(pacer.read().equals(Buffer.alloc(PCM_FRAME_BYTES, 0x74))).toBeTrue();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delay).toBe(20);
    pacer.destroy();
  });

  test("pads the final partial frame and ends", async () => {
    const pacer = createRealtimePcmPacer({ prebufferMs: 100, autoSchedule: false });
    const frames = collect(pacer);
    pacer.end(Buffer.alloc(PCM_FRAME_BYTES / 2, 0x55));
    pacer.tick();
    await once(pacer, "end");

    expect(frames).toHaveLength(1);
    expect(frames[0].subarray(0, PCM_FRAME_BYTES / 2).equals(Buffer.alloc(PCM_FRAME_BYTES / 2, 0x55))).toBeTrue();
    expect(frames[0].subarray(PCM_FRAME_BYTES / 2).equals(Buffer.alloc(PCM_FRAME_BYTES / 2))).toBeTrue();
  });
});
