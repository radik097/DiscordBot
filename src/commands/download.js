import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { loadConfig } from "../structureManager.js";
import { validatePublicMediaUrl } from "../downloads/cobalt.js";
import { downloadService, VIDEO_QUALITIES } from "../downloads/service.js";

const DEFAULT_ALLOWED_ROLES = ["Ботоводство"];
const normalized = (value) => String(value ?? "").trim().toLocaleLowerCase("ru-RU");

export function canUseDownload(interaction, config = {}) {
  if (interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator) ||
      interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  const allowed = new Set((config.downloadAllowedRoles?.length ? config.downloadAllowedRoles : DEFAULT_ALLOWED_ROLES).map(normalized));
  const cache = interaction.member?.roles?.cache;
  if (cache?.some?.((role) => allowed.has(normalized(role.name)))) return true;
  const roleIds = Array.isArray(interaction.member?.roles) ? interaction.member.roles : [];
  return roleIds.some((id) => allowed.has(normalized(interaction.guild?.roles?.cache?.get?.(id)?.name)));
}

export function createDownloadCommand(service = downloadService, configLoader = loadConfig) {
  const data = new SlashCommandBuilder()
    .setName("download")
    .setDescription("Скачать видео или аудио с публичного сайта")
    .setDMPermission(false)
    .addStringOption((option) => option.setName("url").setDescription("Публичная ссылка на видео или публикацию").setRequired(true))
    .addStringOption((option) => option
      .setName("format")
      .setDescription("Что сохранить")
      .addChoices(
        { name: "Видео со звуком", value: "video" },
        { name: "Только аудио", value: "audio" },
      ))
    .addStringOption((option) => option
      .setName("quality")
      .setDescription("Максимальное качество видео")
      .addChoices(...VIDEO_QUALITIES.map((quality) => ({ name: quality === "max" ? "Максимальное" : `${quality}p`, value: quality }))));

  async function execute(interaction) {
    const config = configLoader();
    if (!interaction.guild || !canUseDownload(interaction, config)) {
      return interaction.reply({ content: "Команда доступна только администратору или разрешённой роли.", flags: MessageFlags.Ephemeral });
    }
    const sourceUrl = interaction.options.getString("url", true);
    const format = interaction.options.getString("format") || "video";
    const quality = interaction.options.getString("quality") || "720";
    try { validatePublicMediaUrl(sourceUrl); }
    catch (error) { return interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral }); }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await service.run({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        sourceUrl,
        format,
        quality,
      });
      const discordLimit = Math.max(1, Number(interaction.attachmentSizeLimit) || 10 * 1024 * 1024);
      if (result.size <= discordLimit) {
        try {
          await interaction.editReply({
            content: result.itemCount > 1 ? `Cobalt вернул ${result.itemCount} файлов; отправлен первый.` : `${format === "audio" ? "Аудио" : "Видео"} готово.`,
            files: [{ attachment: result.path, name: result.filename }],
          });
        } finally {
          service.remove(result.path);
        }
        return;
      }
      const link = service.createPublicLink(result);
      await interaction.editReply({
        content: [
          `Файл ${(result.size / 1024 / 1024).toFixed(1)} МБ превышает лимит вложений Discord.`,
          `<${link.url}>`,
          `Ссылка действует до <t:${Math.floor(link.expiresAt / 1000)}:T> и доступна только ограниченное время.`,
        ].join("\n"),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.editReply(`Не удалось скачать медиа: ${error.message}`);
    }
  }
  return { data, execute };
}

export const { data, execute } = createDownloadCommand();
