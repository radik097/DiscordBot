const sinks = new Map();

export function registerMusicReferenceSink(guildId, sink) {
  sinks.set(String(guildId), sink);
  return () => {
    if (sinks.get(String(guildId)) === sink) sinks.delete(String(guildId));
  };
}

export function publishMusicReference(guildId, pcm, volume = 1, capturedAt = Date.now()) {
  const sink = sinks.get(String(guildId));
  if (!sink) return false;
  try {
    sink(pcm, volume, capturedAt);
    return true;
  } catch (error) {
    console.warn(`[transcription:${guildId}] reference tap:`, error.message);
    return false;
  }
}

export function scalePcm16le(input, volume = 1) {
  const gain = Math.min(2, Math.max(0, Number(volume) || 0));
  if (gain === 1) return Buffer.from(input);
  const output = Buffer.allocUnsafe(input.length);
  const samples = input.length - (input.length % 2);
  for (let offset = 0; offset < samples; offset += 2) {
    const value = input.readInt16LE(offset);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * gain))), offset);
  }
  if (samples < input.length) output[input.length - 1] = input[input.length - 1];
  return output;
}
