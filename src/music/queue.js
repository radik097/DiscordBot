import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import { getAudioStream } from "./source.js";
import { saveQueueState, loadQueueState } from "./persistence.js";

const IDLE_LEAVE_MS = 5 * 60 * 1000;
const MAX_QUEUE_SIZE = 500;

// s16le, 48kHz, stereo => bytes/sec of raw PCM that a fully realtime playback consumes.
const PCM_BYTES_PER_SEC = 48000 * 2 * 2;

function sanitizeFileName(name) {
  if (!name) return "(без названия)";
  return name.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100);
}

class GuildQueue {
  constructor(guildId) {
    this.guildId = guildId;
    this.tracks = [];
    this.playing = null;
    this.volume = 1;
    this.connection = null;
    this.textChannelId = null;
    this.idleTimer = null;
    this.currentProcess = null;

    this.player = createAudioPlayer();
    this.player.on("stateChange", (oldState, newState) => {
      console.log(`[music:${guildId}] player: ${oldState.status} -> ${newState.status}`);
    });
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.playing = null;
      this.playNext();
    });
    this.player.on("error", (err) => {
      console.error(`[music:${guildId}] Ошибка плеера:`, err.message, err.resource?.metadata ?? "");
      this.playing = null;
      this.playNext();
    });
  }

  connect(voiceChannel) {
    if (this.connection) return;
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    const subscription = this.connection.subscribe(this.player);
    if (!subscription) console.error(`[music:${this.guildId}] connection.subscribe() вернул undefined — плеер не подписан на соединение!`);

    this.connection.on("stateChange", (oldState, newState) => {
      console.log(`[music:${this.guildId}] connection: ${oldState.status} -> ${newState.status}`);
    });

    entersState(this.connection, VoiceConnectionStatus.Ready, 15000).catch((err) =>
      console.error(`[music:${this.guildId}] Соединение не дошло до Ready:`, err.message)
    );

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        this.destroy();
      }
    });
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  scheduleIdleLeave() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.destroy(), IDLE_LEAVE_MS);
  }

  async enqueue(track) {
    if (this.tracks.length >= MAX_QUEUE_SIZE) {
      throw new Error(`Очередь переполнена (максимум ${MAX_QUEUE_SIZE} треков)`);
    }
    this.tracks.push(track);
    this.clearIdleTimer();
    if (!this.playing) await this.playNext();
  }

  killCurrentProcess() {
    this.stopStatsLogging();
    if (this.currentProcess && !this.currentProcess.killed) {
      this.currentProcess.kill();
    }
    this.currentProcess = null;
  }

  // Logs, once a second, how much audio ffmpeg has buffered (decoded from the
  // cached file) versus how much has actually been played out to the voice
  // connection. If "played" stalls while "buffered" keeps climbing, that's the
  // Discord/voice send side falling behind, not the source — points at CPU.
  startStatsLogging(streamStats) {
    this.stopStatsLogging();
    let lastBytesOut = 0;
    let lastPlaybackMs = 0;
    this.statsInterval = setInterval(() => {
      const resource = this.currentResource;
      if (!resource) return;

      const bufferedDelta = streamStats.bytesOut - lastBytesOut;
      lastBytesOut = streamStats.bytesOut;

      const playbackMs = resource.playbackDuration;
      const playedDelta = ((playbackMs - lastPlaybackMs) / 1000) * PCM_BYTES_PER_SEC;
      lastPlaybackMs = playbackMs;

      console.log(
        `[music:${this.guildId}] буфер: ${(bufferedDelta / 1e6).toFixed(2)} MB/s | воспроизведено: ${(playedDelta / 1e6).toFixed(2)} MB/s`
      );
    }, 1000);
  }

  stopStatsLogging() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    this.statsInterval = null;
  }

  async playNext() {
    this.killCurrentProcess();
    const next = this.tracks.shift();
    if (!next) {
      this.playing = null;
      this.scheduleIdleLeave();
      return;
    }
    this.playing = next;
    try {
      const { stream, type, process: child, quality, stats } = await getAudioStream(next.url, next._quality ?? "best");
      this.currentProcess = child;
      console.log(`[music:${this.guildId}] Поток запущен для "${sanitizeFileName(next.title)}", quality=${quality}, type=${type}`);
      const resource = createAudioResource(stream, { inputType: type, inlineVolume: true });
      resource.volume?.setVolume(this.volume);
      this.currentResource = resource;
      this.player.play(resource);
      this.startStatsLogging(stats);
    } catch (err) {
      const attempts = (next._attempts ?? 0) + 1;
      console.error(`[music:${this.guildId}] Не удалось получить поток для "${sanitizeFileName(next.title)}" (попытка ${attempts}):`, err.message);

      if (err.message.includes("403")) {
        if (!next._quality || next._quality === "best") {
          console.warn(`[music:${this.guildId}] 403 ошибка, пробую худшее качество...`);
          next._quality = "worst";
          next._attempts = 0;
          this.tracks.unshift(next);
          await new Promise((r) => setTimeout(r, 2000));
        } else if (attempts <= 2) {
          next._attempts = attempts;
          this.tracks.unshift(next);
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          console.error(`[music:${this.guildId}] Сдаюсь после ${attempts} попыток и 403 ошибок, пропускаю "${sanitizeFileName(next.title)}"`);
        }
      } else if (attempts <= 2) {
        next._attempts = attempts;
        this.tracks.unshift(next);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        console.error(`[music:${this.guildId}] Сдаюсь после ${attempts} попыток, пропускаю "${sanitizeFileName(next.title)}"`);
      }
      await this.playNext();
    }
  }

  skip() {
    this.player.stop(true);
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  setVolume(v) {
    this.volume = v;
    this.currentResource?.volume?.setVolume(v);
  }

  destroy() {
    this.clearIdleTimer();
    this.stopStatsLogging();
    this.killCurrentProcess();
    this.tracks = [];
    this.playing = null;
    try {
      this.player.stop(true);
    } catch {}
    try {
      this.connection?.destroy();
    } catch {}
    this.connection = null;
    queues.delete(this.guildId);
  }
}

const queues = new Map();

export function getQueue(guildId) {
  let q = queues.get(guildId);
  if (!q) {
    q = new GuildQueue(guildId);
    queues.set(guildId, q);
  }
  return q;
}

export function peekQueue(guildId) {
  return queues.get(guildId) ?? null;
}

export function listQueues() {
  return [...queues.values()];
}

export function getAllQueues() {
  return queues;
}

export function saveAllQueues() {
  saveQueueState(queues);
}

export async function restoreQueueState(client) {
  const state = loadQueueState();
  let restored = 0;
  for (const [guildId, data] of Object.entries(state)) {
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const queue = getQueue(guildId);
      if (data.tracks && Array.isArray(data.tracks)) {
        queue.tracks = data.tracks;
        restored += data.tracks.length;
      }
      if (data.volume) {
        queue.setVolume(data.volume);
      }
    } catch (err) {
      console.error(`[persistence] Ошибка восстановления очереди для гильдии ${guildId}:`, err.message);
    }
  }
  if (restored > 0) {
    console.log(`[persistence] Восстановлено ${restored} треков в очередях`);
  }
}
