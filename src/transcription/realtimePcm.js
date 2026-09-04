const INPUT_FRAME_BYTES = 4;
const DECIMATION = 3;
const GROUP_BYTES = INPUT_FRAME_BYTES * DECIMATION;

function clampInt16(value) {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}

// Discord voice is decoded as signed 16-bit, 48 kHz, stereo PCM. Mistral's
// realtime endpoint expects signed 16-bit, 16 kHz, mono PCM. Averaging three
// stereo frames provides a small low-pass filter before exact 3:1 decimation.
export class RealtimePcm16k {
  constructor() {
    this.pending = Buffer.alloc(0);
  }

  push(input) {
    if (!input?.length) return Buffer.alloc(0);
    const source = this.pending.length ? Buffer.concat([this.pending, Buffer.from(input)]) : Buffer.from(input);
    const groups = Math.floor(source.length / GROUP_BYTES);
    const consumed = groups * GROUP_BYTES;
    this.pending = source.subarray(consumed);
    if (!groups) return Buffer.alloc(0);
    const output = Buffer.allocUnsafe(groups * 2);
    for (let group = 0; group < groups; group += 1) {
      const offset = group * GROUP_BYTES;
      let total = 0;
      for (let frame = 0; frame < DECIMATION; frame += 1) {
        const frameOffset = offset + frame * INPUT_FRAME_BYTES;
        total += source.readInt16LE(frameOffset) + source.readInt16LE(frameOffset + 2);
      }
      output.writeInt16LE(clampInt16(total / 6), group * 2);
    }
    return output;
  }
}

export function isMistralRealtimeProfile(profile) {
  return profile?.provider === "mistral" && profile?.model === "voxtral-mini-transcribe-realtime-2602";
}
