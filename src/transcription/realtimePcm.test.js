import { describe, expect, test } from "bun:test";
import { isMistralRealtimeProfile, RealtimePcm16k } from "./realtimePcm.js";

function stereoFrames(values) {
  const output = Buffer.alloc(values.length * 4);
  values.forEach(([left, right], index) => {
    output.writeInt16LE(left, index * 4);
    output.writeInt16LE(right, index * 4 + 2);
  });
  return output;
}

describe("Mistral realtime PCM conversion", () => {
  test("downmixes 48 kHz stereo and decimates exactly to 16 kHz mono", () => {
    const converter = new RealtimePcm16k();
    const result = converter.push(stereoFrames([[600, 0], [600, 0], [600, 0], [-300, -300], [-300, -300], [-300, -300]]));
    expect([...new Int16Array(result.buffer, result.byteOffset, result.length / 2)]).toEqual([300, -300]);
  });

  test("keeps incomplete input frames across Discord packets", () => {
    const converter = new RealtimePcm16k();
    const input = stereoFrames([[120, 120], [120, 120], [120, 120]]);
    expect(converter.push(input.subarray(0, 8))).toHaveLength(0);
    const result = converter.push(input.subarray(8));
    expect(result.readInt16LE(0)).toBe(120);
  });

  test("recognizes only the dedicated Mistral realtime profile", () => {
    expect(isMistralRealtimeProfile({ provider: "mistral", model: "voxtral-mini-transcribe-realtime-2602" })).toBeTrue();
    expect(isMistralRealtimeProfile({ provider: "mistral", model: "voxtral-mini-latest" })).toBeFalse();
  });
});
