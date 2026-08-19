import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, AttachmentBuilder } from "discord.js";
import { loadConfig, saveConfig, buildStructure, wipeStructure, rebuildStructure, exportStructure } from "../structureManager.js";

export const data = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Управление структурой сервера (роли/категории/каналы) из config/structure.json")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) => sub.setName("build").setDescription("Создать недостающие роли/категории/каналы из конфига"))
  .addSubcommand((sub) =>
    sub
      .setName("export")
      .setDescription("Снять текущую структуру сервера (роли/категории/каналы/права) и прислать как structure.json")
      .addBooleanOption((opt) =>
        opt.setName("save").setDescription("Также перезаписать config/structure.json на диске бота").setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("wipe")
      .setDescription("Удалить ВСЕ каналы и роли на сервере (кроме системных)")
      .addBooleanOption((opt) =>
        opt.setName("confirm").setDescription("Подтвердите: да, я хочу удалить всё").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("rebuild")
      .setDescription("Удалить всё и пересоздать структуру заново из конфига")
      .addBooleanOption((opt) =>
        opt.setName("confirm").setDescription("Подтвердите: да, я хочу удалить и пересоздать всё").setRequired(true)
      )
  );

function chunk(lines, limit = 1900) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : ["(пусто)"];
}

async function sendLog(interaction, title, log) {
  const chunks = chunk(log);
  await interaction.editReply(`**${title}**\n\`\`\`\n${chunks[0]}\n\`\`\``);
  for (const rest of chunks.slice(1)) {
    await interaction.followUp({ content: `\`\`\`\n${rest}\n\`\`\``, flags: MessageFlags.Ephemeral });
  }
}

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ content: "Команда работает только на сервере.", flags: MessageFlags.Ephemeral });
  }

  if (sub === "wipe" || sub === "rebuild") {
    const confirmed = interaction.options.getBoolean("confirm", true);
    if (!confirmed) {
      return interaction.reply({
        content: "Отменено: нужно передать `confirm: true`, чтобы подтвердить удаление всех каналов и ролей.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  await interaction.deferReply();

  try {
    if (sub === "build") {
      const config = loadConfig();
      const log = await buildStructure(guild, config, { botMemberId: guild.members.me?.id });
      await sendLog(interaction, "Готово: build", log);
    } else if (sub === "export") {
      const config = exportStructure(guild, { botMemberId: guild.members.me?.id });
      const json = JSON.stringify(config, null, 2) + "\n";
      const shouldSave = interaction.options.getBoolean("save") ?? false;
      if (shouldSave) saveConfig(config);
      const file = new AttachmentBuilder(Buffer.from(json, "utf-8"), { name: "structure.json" });
      await interaction.editReply({
        content: `Готово: export — роли: ${config.roles.length}, категории: ${config.categories.length}, каналы: ${config.channels.length}.${
          shouldSave ? "\nТакже перезаписал config/structure.json на диске бота." : ""
        }`,
        files: [file],
      });
    } else if (sub === "wipe") {
      const config = loadConfig();
      const log = await wipeStructure(guild, config);
      await sendLog(interaction, "Готово: wipe", log);
    } else if (sub === "rebuild") {
      const config = loadConfig();
      const log = await rebuildStructure(guild, config, { botMemberId: guild.members.me?.id });
      await sendLog(interaction, "Готово: rebuild", log);
    }
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Ошибка при выполнении \`${sub}\`: ${err.message}`).catch(() => {});
  }
}
