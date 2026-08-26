import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { BOT_OPERATOR_ROLE_NAME, hasBotOperatorRole } from "./phone.js";
import { getAccessControl } from "../web/accessControlRegistry.js";

export const data = new SlashCommandBuilder()
  .setName("get-url")
  .setDescription("Выдать суточную ссылку для входа в веб-панель по электронной почте")
  .addStringOption((option) => option
    .setName("email")
    .setDescription("Электронная почта получателя")
    .setRequired(true)
    .setMinLength(5)
    .setMaxLength(254))
  .setDMPermission(false);

export async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({
      content: "Команда работает только на сервере.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!hasBotOperatorRole(interaction)) {
    return interaction.reply({
      content: `Команда доступна только участникам с ролью «${BOT_OPERATOR_ROLE_NAME}».`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const access = getAccessControl(interaction.client);
  if (!access) return interaction.editReply("Система веб-доступа ещё не запущена. Попробуйте снова через несколько секунд.");

  try {
    const email = interaction.options.getString("email", true);
    const invite = access.issueInvite(email, "day", `discord:${interaction.user?.id ?? "unknown"}`);
    const expiresAt = Math.floor(invite.expiresAt / 1000);
    return interaction.editReply({
      content: [
        `**Ссылка для ${invite.email}:**`,
        `<${invite.url}>`,
        `Ссылка одноразовая и действует до <t:${expiresAt}:F> (<t:${expiresAt}:R>).`,
        "После подтверждения этой почты кодом пользователь получит доступ к панели на 24 часа.",
        "Не пересылайте ссылку: использовать её сможет только указанный адрес.",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    return interaction.editReply(`Не удалось создать ссылку: ${error.message}`);
  }
}
