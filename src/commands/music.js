import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from "discord.js";
import { loadConfig } from "../structureManager.js";
import { resolveInput } from "../music/source.js";
import { getQueue, peekQueue } from "../music/queue.js";

function formatDuration(totalSec) {
  const sec = Math.floor(totalSec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function checkAccess(interaction) {
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({ content: "Команда работает только на сервере.", flags: MessageFlags.Ephemeral });
    return false;
  }
  const isAdmin = interaction.member.permissions?.has?.(PermissionFlagsBits.Administrator);
  if (isAdmin) return true;

  const config = loadConfig();
  const allowed = new Set(config.musicAllowedRoles ?? []);
  const hasRole = interaction.member.roles.cache.some((r) => allowed.has(r.name));
  if (!hasRole) {
    await interaction.reply({ content: "У вас нет доступа к музыкальным командам.", flags: MessageFlags.Ephemeral });
    return false;
  }
  return true;
}

const play = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Включить трек или добавить YouTube-плейлист в очередь")
    .addStringOption((o) => o.setName("query").setDescription("Трек, запрос, ссылка или ID плейлиста").setRequired(true)),
  async execute(interaction) {
    if (!(await checkAccess(interaction))) return;
    const voiceChannel = interaction.member.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: "Зайдите в голосовой канал, чтобы включить музыку.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    const query = interaction.options.getString("query", true);

    let resolved;
    try {
      resolved = await resolveInput(query, interaction.user.tag);
    } catch (err) {
      return interaction.editReply(`Не удалось обработать запрос: ${err.message}`);
    }
    if (!resolved.tracks.length) return interaction.editReply("В плейлисте или поиске нет доступных треков.");

    const queue = getQueue(interaction.guildId);
    queue.textChannelId = interaction.channelId;
    queue.connect(voiceChannel);
    const wasIdle = !queue.playing;
    try {
      await queue.enqueueMany(resolved.tracks);
    } catch (err) {
      return interaction.editReply(`Не удалось добавить в очередь: ${err.message}`);
    }

    if (resolved.kind === "playlist") {
      const limited = resolved.limited ? " (первые 500)" : "";
      await interaction.editReply(
        `📃 Плейлист **${resolved.title}**: добавлено ${resolved.tracks.length} треков${limited}. ${wasIdle ? "Воспроизведение началось." : "Треки поставлены в очередь."}`
      );
      return;
    }

    const [track] = resolved.tracks;
    await interaction.editReply(`${wasIdle ? "▶️ Играю" : "➕ Добавлено в очередь"}: **${track.title}** (${formatDuration(track.durationSec)})`);
  },
};

const skip = {
  data: new SlashCommandBuilder().setName("skip").setDescription("Пропустить текущий трек"),
  async execute(interaction) {
    if (!(await checkAccess(interaction))) return;
    const queue = peekQueue(interaction.guildId);
    if (!queue?.playing) {
      return interaction.reply({ content: "Сейчас ничего не играет.", flags: MessageFlags.Ephemeral });
    }
    const title = queue.playing.title;
    queue.skip();
    await interaction.reply(`⏭️ Пропущено: **${title}**`);
  },
};

const stop = {
  data: new SlashCommandBuilder().setName("stop").setDescription("Остановить музыку, очистить очередь и выйти из канала"),
  async execute(interaction) {
    if (!(await checkAccess(interaction))) return;
    const queue = peekQueue(interaction.guildId);
    if (!queue) {
      return interaction.reply({ content: "Бот сейчас не в голосовом канале.", flags: MessageFlags.Ephemeral });
    }
    queue.destroy();
    await interaction.reply("⏹️ Остановлено, очередь очищена, вышел из канала.");
  },
};

const pause = {
  data: new SlashCommandBuilder().setName("pause").setDescription("Поставить воспроизведение на паузу"),
  async execute(interaction) {
    if (!(await checkAccess(interaction))) return;
    const queue = peekQueue(interaction.guildId);
    if (!queue?.playing) {
      return interaction.reply({ content: "Сейчас ничего не играет.", flags: MessageFlags.Ephemeral });
    }
    queue.pause();
    await interaction.reply("⏸️ Пауза.");
  },
};

const resume = {
  data: new SlashCommandBuilder().setName("resume").setDescription("Снять с паузы"),
  async execute(interaction) {
    if (!(await checkAccess(interaction))) return;
    const queue = peekQueue(interaction.guildId);
    if (!queue?.playing) {
      return interaction.reply({ content: "Сейчас ничего не играет.", flags: MessageFlags.Ephemeral });
    }
    queue.resume();
    await interaction.reply("▶️ Продолжаю.");
  },
};

const queueCmd = {
  data: new SlashCommandBuilder().setName("queue").setDescription("Показать очередь треков"),
  async execute(interaction) {
    const queue = peekQueue(interaction.guildId);
    if (!queue || (!queue.playing && queue.tracks.length === 0)) {
      return interaction.reply({ content: "Очередь пуста.", flags: MessageFlags.Ephemeral });
    }
    const lines = [];
    if (queue.playing) lines.push(`▶️ Сейчас играет: **${queue.playing.title}** (${formatDuration(queue.playing.durationSec)})`);
    queue.tracks.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title} (${formatDuration(t.durationSec)})`));
    if (queue.tracks.length > 10) lines.push(`… и ещё ${queue.tracks.length - 10}`);
    await interaction.reply(lines.join("\n"));
  },
};

const nowplaying = {
  data: new SlashCommandBuilder().setName("nowplaying").setDescription("Что сейчас играет"),
  async execute(interaction) {
    const queue = peekQueue(interaction.guildId);
    if (!queue?.playing) {
      return interaction.reply({ content: "Сейчас ничего не играет.", flags: MessageFlags.Ephemeral });
    }
    await interaction.reply(
      `▶️ **${queue.playing.title}** (${formatDuration(queue.playing.durationSec)}) — запросил(а) ${queue.playing.requestedBy}`
    );
  },
};

const volume = {
  data: new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Изменить громкость (0-200%)")
    .addIntegerOption((o) => o.setName("level").setDescription("Проценты, например 100").setRequired(true).setMinValue(0).setMaxValue(200)),
  async execute(interaction) {
    if (!(await checkAccess(interaction))) return;
    const queue = peekQueue(interaction.guildId);
    if (!queue) {
      return interaction.reply({ content: "Бот сейчас не в голосовом канале.", flags: MessageFlags.Ephemeral });
    }
    const level = interaction.options.getInteger("level", true);
    queue.setVolume(level / 100);
    await interaction.reply(`🔊 Громкость: ${level}%`);
  },
};

export const commands = [play, skip, stop, pause, resume, queueCmd, nowplaying, volume];
