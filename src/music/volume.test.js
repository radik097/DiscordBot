import { afterEach, describe, expect, test } from "bun:test";
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

  test("applies the new level to the active PCM volume transformer", () => {
    const queue = getQueue(`volume-test-${Date.now()}`);
    queues.push(queue);
    let applied = null;
    queue.currentVolumeTransformer = { setVolume: (value) => { applied = value; } };

    expect(queue.setVolume(0)).toBe(0);
    expect(queue.volume).toBe(0);
    expect(applied).toBe(0);

    expect(queue.setVolume(1.35)).toBe(1.35);
    expect(queue.volume).toBe(1.35);
    expect(applied).toBe(1.35);
    expect(() => queue.setVolume(Number.NaN)).toThrow("Громкость");
  });
});
