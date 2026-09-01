import { clearAllSavedQueueStates, clearSavedQueueState, getSavedQueueStates, setSavedQueueState } from "../db.js";

export function saveQueueState(queues) {
  try {
    const state = {};
    for (const [guildId, queue] of queues) {
      if (queue.playing || queue.tracks.length > 0) {
        state[guildId] = {
          version: 2,
          playing: queue.getPersistedPlaying?.() ?? queue.playing,
          tracks: queue.tracks,
          volume: queue.volume,
          activePlaylist: queue.activePlaylist ?? null,
          voiceChannelId: queue.connection?.joinConfig?.channelId ?? null,
          textChannelId: queue.textChannelId ?? null,
          savedAt: Date.now(),
        };
      }
    }
    for (const [guildId, payload] of Object.entries(state)) {
      setSavedQueueState(guildId, payload.version, payload, payload.savedAt);
    }

    const activeGuildIds = new Set(Object.keys(state));
    for (const row of getSavedQueueStates()) {
      if (!activeGuildIds.has(row.guildId)) {
        clearSavedQueueState(row.guildId);
      }
    }
    console.log(`[persistence] Сохранено состояние ${Object.keys(state).length} очередей`);
  } catch (err) {
    console.error(`[persistence] Ошибка сохранения состояния:`, err.message);
  }
}

export function loadQueueState() {
  try {
    const state = {};
    for (const record of getSavedQueueStates()) {
      if (record.guildId && record.state) {
        state[record.guildId] = record.state;
      }
    }
    console.log(`[persistence] Загружено состояние ${Object.keys(state).length} очередей`);
    return state;
  } catch (err) {
    console.error(`[persistence] Ошибка загрузки состояния:`, err.message);
    return {};
  }
}

export function clearQueueState() {
  try {
    clearAllSavedQueueStates();
    console.log(`[persistence] Состояние очередей очищено`);
  } catch (err) {
    console.error(`[persistence] Ошибка очистки состояния:`, err.message);
  }
}
