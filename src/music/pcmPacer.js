import { Duplex } from "node:stream";

export const PCM_FRAME_DURATION_MS = 20;
export const PCM_FRAME_BYTES = 48_000 * 2 * 2 * PCM_FRAME_DURATION_MS / 1000;

const DEFAULT_PREBUFFER_MS = 1_000;
const DEFAULT_MAX_BUFFER_MS = 8_000;
const DEFAULT_MAX_UNDERRUN_MS = 10_000;

function framesForDuration(durationMs) {
  return Math.max(1, Math.ceil(durationMs / PCM_FRAME_DURATION_MS));
}

export class RealtimePcmPacer extends Duplex {
  constructor({
    prebufferMs = DEFAULT_PREBUFFER_MS,
    maxBufferMs = DEFAULT_MAX_BUFFER_MS,
    maxUnderrunMs = DEFAULT_MAX_UNDERRUN_MS,
    autoSchedule = true,
    schedule = setTimeout,
    cancel = clearTimeout,
    now = () => performance.now(),
    onFrame = null,
  } = {}) {
    super({
      readableHighWaterMark: PCM_FRAME_BYTES,
      writableHighWaterMark: PCM_FRAME_BYTES,
    });
    this.prebufferBytes = framesForDuration(prebufferMs) * PCM_FRAME_BYTES;
    this.maxBufferBytes = Math.max(this.prebufferBytes, framesForDuration(maxBufferMs) * PCM_FRAME_BYTES);
    this.resumeBufferBytes = Math.max(this.prebufferBytes, Math.floor(this.maxBufferBytes / 2));
    this.maxUnderrunFrames = framesForDuration(maxUnderrunMs);
    this.autoSchedule = autoSchedule;
    this.schedule = schedule;
    this.cancel = cancel;
    this.now = now;
    this.onFrame = typeof onFrame === "function" ? onFrame : null;

    this.chunks = [];
    this.chunkOffset = 0;
    this.bufferedBytes = 0;
    this.started = false;
    this.sourceEnded = false;
    // One frame may be prepared before a consumer attaches. The one-frame
    // readable high-water mark then stops production until the consumer reads.
    this.readDemand = true;
    this.timer = null;
    this.nextTickAt = null;
    this.pendingWriteCallback = null;
    this.finalCallback = null;
    this.underrunFrames = 0;
    this.stats = { emittedFrames: 0, silenceFrames: 0, underruns: 0 };
  }

  _read() {
    this.readDemand = true;
    this.#scheduleNext();
  }

  _write(chunk, _encoding, callback) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length) {
      this.chunks.push(bytes);
      this.bufferedBytes += bytes.length;
    }
    if (!this.started && this.bufferedBytes >= this.prebufferBytes) this.#start();

    if (this.bufferedBytes >= this.maxBufferBytes) {
      this.pendingWriteCallback = callback;
    } else {
      callback();
    }
  }

  _final(callback) {
    this.sourceEnded = true;
    this.finalCallback = callback;
    if (!this.started && this.bufferedBytes > 0) this.#start();
    if (!this.started) this.#finish();
  }

  _destroy(error, callback) {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    const writeCallback = this.pendingWriteCallback;
    this.pendingWriteCallback = null;
    if (writeCallback) writeCallback(error ?? new Error("PCM pacer остановлен"));
    const finalCallback = this.finalCallback;
    this.finalCallback = null;
    if (finalCallback) finalCallback();
    this.chunks = [];
    this.bufferedBytes = 0;
    callback(error);
  }

  #start() {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.nextTickAt = this.now() + PCM_FRAME_DURATION_MS;
    this.#scheduleNext();
  }

  #scheduleNext() {
    if (!this.autoSchedule || !this.started || !this.readDemand || this.timer !== null || this.destroyed) return;
    const currentTime = this.now();
    if (this.nextTickAt === null || currentTime - this.nextTickAt >= PCM_FRAME_DURATION_MS) {
      this.nextTickAt = currentTime + PCM_FRAME_DURATION_MS;
    }
    const delay = Math.max(1, this.nextTickAt - currentTime);
    this.timer = this.schedule(() => {
      this.timer = null;
      const firedAt = this.now();
      if (firedAt - this.nextTickAt >= PCM_FRAME_DURATION_MS) {
        // A genuine stall must not create a chain of near-zero-delay catch-up
        // callbacks. Resume from the current wall-clock position instead.
        this.nextTickAt = firedAt + PCM_FRAME_DURATION_MS;
      } else {
        // Correct ordinary timer overhead so the producer remains at 50 fps.
        this.nextTickAt += PCM_FRAME_DURATION_MS;
      }
      this.tick();
    }, delay);
    this.timer?.unref?.();
  }

  #takeFrame() {
    const frame = Buffer.allocUnsafe(PCM_FRAME_BYTES);
    let written = 0;
    while (written < PCM_FRAME_BYTES && this.chunks.length) {
      const current = this.chunks[0];
      const available = current.length - this.chunkOffset;
      const length = Math.min(available, PCM_FRAME_BYTES - written);
      current.copy(frame, written, this.chunkOffset, this.chunkOffset + length);
      written += length;
      this.chunkOffset += length;
      this.bufferedBytes -= length;
      if (this.chunkOffset === current.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }
    if (written < PCM_FRAME_BYTES) frame.fill(0, written);
    return frame;
  }

  #releaseWriter() {
    if (!this.pendingWriteCallback || this.bufferedBytes > this.resumeBufferBytes) return;
    const callback = this.pendingWriteCallback;
    this.pendingWriteCallback = null;
    callback();
  }

  #finish() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    const callback = this.finalCallback;
    this.finalCallback = null;
    if (callback) callback();
    if (!this.readableEnded && !this.destroyed) this.push(null);
  }

  tick() {
    if (!this.started || this.destroyed || !this.readDemand) return false;

    let frame;
    let silence = false;
    if (this.bufferedBytes >= PCM_FRAME_BYTES || (this.sourceEnded && this.bufferedBytes > 0)) {
      frame = this.#takeFrame();
      this.underrunFrames = 0;
    } else if (!this.sourceEnded) {
      this.underrunFrames += 1;
      this.stats.underruns += 1;
      if (this.underrunFrames > this.maxUnderrunFrames) {
        this.destroy(new Error(`PCM-поток не возобновился за ${this.maxUnderrunFrames * PCM_FRAME_DURATION_MS} мс`));
        return false;
      }
      frame = Buffer.alloc(PCM_FRAME_BYTES);
      silence = true;
    } else {
      this.#finish();
      return false;
    }

    this.stats.emittedFrames += 1;
    if (silence) this.stats.silenceFrames += 1;
    this.onFrame?.(frame, { silence, bufferedBytes: this.bufferedBytes });
    this.readDemand = this.push(frame);
    this.#releaseWriter();

    if (this.sourceEnded && this.bufferedBytes === 0) {
      this.#finish();
    } else {
      this.#scheduleNext();
    }
    return true;
  }
}

export function createRealtimePcmPacer(options) {
  return new RealtimePcmPacer(options);
}
