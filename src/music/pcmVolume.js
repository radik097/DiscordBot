import { Transform } from "node:stream";

const PCM_MIN = -32768;
const PCM_MAX = 32767;

function clampSample(value) {
  return Math.max(PCM_MIN, Math.min(PCM_MAX, Math.round(value)));
}

export function scalePcm16le(input, volume) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const output = Buffer.allocUnsafe(source.length);
  const evenLength = source.length - (source.length % 2);
  for (let offset = 0; offset < evenLength; offset += 2) {
    output.writeInt16LE(clampSample(source.readInt16LE(offset) * volume), offset);
  }
  if (evenLength !== source.length) output[evenLength] = source[evenLength];
  return output;
}

export class PcmVolumeTransformer extends Transform {
  constructor(volume = 1) {
    super();
    this.volume = volume;
    this.pendingByte = null;
  }

  setVolume(volume) {
    this.volume = volume;
    return this.volume;
  }

  _transform(chunk, _encoding, callback) {
    let input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.pendingByte !== null) {
      input = Buffer.concat([Buffer.from([this.pendingByte]), input]);
      this.pendingByte = null;
    }
    if (input.length % 2) {
      this.pendingByte = input[input.length - 1];
      input = input.subarray(0, input.length - 1);
    }
    callback(null, input.length ? scalePcm16le(input, this.volume) : undefined);
  }

  _flush(callback) {
    const tail = this.pendingByte === null ? undefined : Buffer.from([this.pendingByte]);
    this.pendingByte = null;
    callback(null, tail);
  }
}
