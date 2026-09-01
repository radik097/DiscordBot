import { describe, expect, test } from "bun:test";
import { publishMusicReference, registerMusicReferenceSink, scalePcm16le } from "./reference.js";

describe("music reference tap", () => {
  test("publishes only to the matching guild and unregisters cleanly", () => {
    const seen = [];
    const unregister = registerMusicReferenceSink("guild-a", (pcm, volume, time) => seen.push({ pcm, volume, time }));
    expect(publishMusicReference("guild-b", Buffer.alloc(2), 1, 1)).toBe(false);
    expect(publishMusicReference("guild-a", Buffer.from([1, 2]), 0.5, 123)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].time).toBe(123);
    unregister();
    expect(publishMusicReference("guild-a", Buffer.alloc(2))).toBe(false);
  });

  test("applies the same bounded gain to signed PCM", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(10_000, 0);
    pcm.writeInt16LE(-20_000, 2);
    const scaled = scalePcm16le(pcm, 0.5);
    expect(scaled.readInt16LE(0)).toBe(5_000);
    expect(scaled.readInt16LE(2)).toBe(-10_000);
  });
});
