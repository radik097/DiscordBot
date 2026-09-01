import { readFileSync } from "node:fs";
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

const RULES_PATH = new URL("../../config/rules.md", import.meta.url);
const RULES_CHANNEL_NAME = "📜-правила";

export const data = new SlashCommandBuilder()
  .setName("rules")
  .setDescription("Публикация правил и кнопки принятия правил")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub.setName("post").setDescription(`Опубликовать правила из config/rules.md в канал ${RULES_CHANNEL_NAME} с кнопкой принятия`)
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub !== "post") return;

  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ content: "Команда работает только на сервере.", flags: MessageFlags.Ephemeral });
  }

  const channel = guild.channels.cache.find((c) => c.name === RULES_CHANNEL_NAME && c.isTextBased?.());
  if (!channel) {
    return interaction.reply({
      content: `Канал "${RULES_CHANNEL_NAME}" не найден. Сначала создайте структуру через /setup build.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  let text;
  try {
    text = readFileSync(RULES_PATH, "utf-8");
  } catch (err) {
    return interaction.reply({ content: `Не удалось прочитать config/rules.md: ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setTitle("📜 Правила сервера")
    .setDescription(text.slice(0, 4096))
    .setColor(0x57f287);

  const button = new ButtonBuilder().setCustomId("rules_accept").setLabel("✅ Принять правила").setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder().addComponents(button);

  await channel.send({ embeds: [embed], components: [row] });
  await interaction.reply({ content: `Опубликовано в ${channel}.`, flags: MessageFlags.Ephemeral });
}
