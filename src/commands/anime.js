import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { AnimeNotFoundError, findRandomAnime } from "../anime/anilist.js";

export const ANIME_GENRES = [
  ["Экшен", "Action"],
  ["Приключения", "Adventure"],
  ["Комедия", "Comedy"],
  ["Драма", "Drama"],
  ["Этти", "Ecchi"],
  ["Фэнтези", "Fantasy"],
  ["Ужасы", "Horror"],
  ["Махо-сёдзё", "Mahou Shoujo"],
  ["Меха", "Mecha"],
  ["Музыка", "Music"],
  ["Мистика", "Mystery"],
  ["Психология", "Psychological"],
  ["Романтика", "Romance"],
  ["Научная фантастика", "Sci-Fi"],
  ["Повседневность", "Slice of Life"],
  ["Спорт", "Sports"],
  ["Сверхъестественное", "Supernatural"],
  ["Триллер", "Thriller"],
];

const FORMAT_NAMES = {
  TV: "TV-сериал",
  TV_SHORT: "Короткий TV-сериал",
  MOVIE: "Фильм",
  SPECIAL: "Спецвыпуск",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Музыкальное видео",
};

function cleanDescription(value) {
  const text = String(value ?? "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return "Описание отсутствует.";
  return text.length > 900 ? `${text.slice(0, 897)}…` : text;
}

function embedColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value ?? "") ? Number.parseInt(value.slice(1), 16) : 0x5865f2;
}

export function createAnimeCommand(findRandomAnimeImpl = findRandomAnime) {
  const data = new SlashCommandBuilder()
    .setName("anime")
    .setDescription("Выбрать случайное аниме по жанру и минимальному году")
    .addStringOption((option) =>
      option
        .setName("genre")
        .setDescription("Жанр аниме")
        .setRequired(true)
        .addChoices(...ANIME_GENRES.map(([name, value]) => ({ name, value })))
    )
    .addIntegerOption((option) =>
      option
        .setName("min_year")
        .setDescription("Не старше этого года выпуска")
        .setRequired(true)
        .setMinValue(1917)
        .setMaxValue(new Date().getUTCFullYear() + 1)
    );

  async function execute(interaction) {
    const genre = interaction.options.getString("genre", true);
    const minYear = interaction.options.getInteger("min_year", true);
    await interaction.deferReply();

    try {
      const anime = await findRandomAnimeImpl({ genre, minYear });
      const title = anime.title?.english || anime.title?.romaji || anime.title?.native || "Без названия";
      const alternateTitle = anime.title?.romaji && anime.title.romaji !== title ? anime.title.romaji : null;
      const aniListUrl = /^https:\/\/anilist\.co\/anime\/\d+/.test(anime.siteUrl ?? "")
        ? anime.siteUrl
        : `https://anilist.co/anime/${anime.id}`;
      const aniDbSearchUrl = `https://anidb.net/perl-bin/animedb.pl?show=animelist&adb.search=${encodeURIComponent(title)}&do.search=search`;
      const fields = [
        { name: "Год", value: String(anime.startDate?.year ?? "не указан"), inline: true },
        { name: "Формат", value: FORMAT_NAMES[anime.format] ?? anime.format ?? "не указан", inline: true },
        { name: "Эпизоды", value: String(anime.episodes ?? "не указано"), inline: true },
        { name: "Оценка", value: anime.averageScore ? `${anime.averageScore}/100` : "нет оценки", inline: true },
        { name: "Жанры", value: anime.genres?.join(", ") || genre, inline: false },
        { name: "Ссылки", value: `[AniList](${aniListUrl}) • [Поиск на AniDB](${aniDbSearchUrl})`, inline: false },
      ];

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setURL(aniListUrl)
        .setColor(embedColor(anime.coverImage?.color))
        .setDescription(`${alternateTitle ? `*${alternateTitle}*\n\n` : ""}${cleanDescription(anime.description)}`)
        .addFields(fields)
        .setFooter({ text: `Источник: AniList • фильтр: ${genre}, с ${minYear} года` });
      if (anime.coverImage?.large) embed.setThumbnail(anime.coverImage.large);

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      const message = error instanceof AnimeNotFoundError ? error.message : `Не удалось получить рекомендацию: ${error.message}`;
      await interaction.editReply(message);
    }
  }

  return { data, execute };
}

export const { data, execute } = createAnimeCommand();
