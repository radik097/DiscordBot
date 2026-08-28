import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { getRemoteAccess } from "../web/remoteAccessRegistry.js";

export const BOT_OPERATOR_ROLE_NAME = "Ботоводство";

const normalizedRoleName = (value) => String(value ?? "").trim().toLocaleLowerCase("ru-RU");

export function hasBotOperatorRole(interaction) {
  const expected = normalizedRoleName(BOT_OPERATOR_ROLE_NAME);
  const cachedRoles = interaction.member?.roles?.cache;
  if (cachedRoles?.some?.((role) => normalizedRoleName(role.name) === expected)) return true;

  // Discord.js normally supplies a GuildMember, but raw interaction fixtures can
  // contain only role IDs. Supporting both keeps the authorization check closed
  // instead of falling back to Administrator or another broad permission.
  const roleIds = Array.isArray(interaction.member?.roles) ? interaction.member.roles : [];
  return roleIds.some((roleId) => {
    const role = interaction.guild?.roles?.cache?.get?.(roleId);
    return normalizedRoleName(role?.name) === expected;
  });
}

export const data = new SlashCommandBuilder()
  .setName("phone")
  .setDescription("Получить одноразовую ссылку для входа в панель с телефона")
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

  const remoteAccess = getRemoteAccess(interaction.client);
  if (!remoteAccess) {
    return interaction.editReply("Удалённый доступ ещё не запущен. Попробуйте снова через несколько секунд.");
  }

  try {
    const pairing = await remoteAccess.start();
    const expiresAt = Math.floor(pairing.pairExpiresAt / 1000);
    return interaction.editReply({
      content: [
        "**Одноразовая ссылка для подключения телефона:**",
        `<${pairing.connectUrl}>`,
        `Ссылка действует до <t:${expiresAt}:T> (<t:${expiresAt}:R>) и сработает только один раз.`,
        "Не пересылайте её: человек, который первым подтвердит подключение, получит доступ к панели.",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error(`[phone] Не удалось создать ссылку для ${interaction.user?.tag ?? interaction.user?.id ?? "unknown"}:`, err.message);
    return interaction.editReply(`Не удалось создать ссылку: ${err.message}`);
  }
}
