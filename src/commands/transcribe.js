import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { hasBotOperatorRole } from "./phone.js";
import { transcriptionService } from "../transcription/service.js";

export function canUseTranscription(interaction) {
  return Boolean(
    interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator)
    || hasBotOperatorRole(interaction)
  );
}

function latestSession(service, guildId) {
  return service.status(guildId).sessions[0] || null;
}

export function createTranscribeCommand(service = transcriptionService) {
  const data = new SlashCommandBuilder()
    .setName("transcribe")
    .setDescription("Локальная транскрипция голосового канала")
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName("start")
      .setDescription("Начать транскрипцию текущего голосового канала")
      .addStringOption((option) => option.setName("language").setDescription("Язык распознавания").addChoices(
        { name: "Авто: русский или английский", value: "auto" },
        { name: "Русский", value: "ru" },
        { name: "English", value: "en" },
      )))
    .addSubcommand((sub) => sub.setName("status").setDescription("Показать статус транскрипции"))
    .addSubcommand((sub) => sub.setName("stop").setDescription("Остановить и финализировать транскрипцию"))
    .addSubcommand((sub) => sub
      .setName("export")
      .setDescription("Экспортировать транскрипцию")
      .addStringOption((option) => option.setName("format").setDescription("Формат файла").setRequired(true).addChoices(
        { name: "Текст TXT", value: "txt" }, { name: "Субтитры SRT", value: "srt" },
      ))
      .addStringOption((option) => option.setName("session").setDescription("ID сессии; по умолчанию последняя")))
    .addSubcommand((sub) => sub
      .setName("delete")
      .setDescription("Удалить транскрипцию и сохранённое аудио")
      .addStringOption((option) => option.setName("session").setDescription("ID сессии").setRequired(true)));

  async function execute(interaction) {
    if (!canUseTranscription(interaction)) {
      return interaction.reply({ content: "Команда доступна только администратору или роли Ботоводство.", flags: MessageFlags.Ephemeral });
    }
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "start") {
      const voiceChannel = interaction.member.voice?.channel;
      if (!voiceChannel) return interaction.reply({ content: "Сначала войдите в голосовой канал.", flags: MessageFlags.Ephemeral });
      await interaction.deferReply();
      const session = await service.start({
        guild: interaction.guild,
        voiceChannel,
        announceChannel: interaction.channel,
        language: interaction.options.getString("language") || "auto",
        startedById: interaction.user.id,
        startedByTag: interaction.user.tag,
      });
      return interaction.editReply(
        `🔴 **Транскрипция начата** в ${voiceChannel}. Инициатор: ${interaction.user}. `
        + `Аудиочанки хранятся 7 дней. ID: \`${session.id}\``
      );
    }
    if (subcommand === "stop") {
      await interaction.deferReply();
      const session = await service.stop(interaction.guildId);
      return interaction.editReply(`⏹️ Запись остановлена. Остаток поставлен на обработку; статус: **${session.status}**. ID: \`${session.id}\``);
    }
    if (subcommand === "status") {
      const status = service.status(interaction.guildId);
      if (!status.active) return interaction.reply({ content: `Активной записи нет. Последних сессий: ${status.sessions.length}.`, flags: MessageFlags.Ephemeral });
      const session = service.details(status.active.id) || status.active;
      return interaction.reply({
        content: `🔴 Сессия \`${session.id}\` · ${session.status} · чанков ${session.chunks?.length || 0} · очередь ${status.workerQueue}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (subcommand === "export") {
      const requested = interaction.options.getString("session") || latestSession(service, interaction.guildId)?.id;
      if (!requested) return interaction.reply({ content: "Нет сессий для экспорта.", flags: MessageFlags.Ephemeral });
      const format = interaction.options.getString("format", true);
      const result = service.export(requested, format);
      return interaction.reply({
        content: result.partial ? "Экспорт содержит только уже обработанные чанки." : "Экспорт готов.",
        files: [{ attachment: Buffer.from(result.content, "utf8"), name: result.filename }],
        flags: MessageFlags.Ephemeral,
      });
    }
    if (subcommand === "delete") {
      const id = interaction.options.getString("session", true);
      const deleted = service.delete(id);
      return interaction.reply({ content: deleted ? `Сессия \`${id}\` удалена.` : "Сессия не найдена.", flags: MessageFlags.Ephemeral });
    }
  }

  return { data, execute };
}

export const { data, execute } = createTranscribeCommand();
