import { describe, expect, test } from "bun:test";
import { ANIME_GENRES, createAnimeCommand } from "./commands/anime.js";

describe("/anime", () => {
  test("registers required genre choices and minimum year", () => {
    const command = createAnimeCommand().data.toJSON();
    expect(command.name).toBe("anime");
    expect(command.options.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: "genre", required: true },
      { name: "min_year", required: true },
    ]);
    expect(command.options[0].choices).toHaveLength(ANIME_GENRES.length);
    expect(command.options[1].min_value).toBe(1917);
  });

  test("returns one AniList result as an embed", async () => {
    const edits = [];
    const command = createAnimeCommand(async () => ({
      id: 42,
      title: { english: "Example Anime", romaji: "Example no Anime" },
      description: "A test description.",
      startDate: { year: 2024 },
      episodes: 12,
      averageScore: 81,
      genres: ["Action", "Fantasy"],
      format: "TV",
      siteUrl: "https://anilist.co/anime/42",
      coverImage: { large: "https://s4.anilist.co/file/example.jpg", color: "#123456" },
    }));
    const interaction = {
      options: {
        getString: () => "Action",
        getInteger: () => 2020,
      },
      deferReply: async () => {},
      editReply: async (payload) => edits.push(payload),
    };

    await command.execute(interaction);
    expect(edits).toHaveLength(1);
    expect(edits[0].embeds[0].data).toMatchObject({
      title: "Example Anime",
      url: "https://anilist.co/anime/42",
      color: 0x123456,
    });
    expect(edits[0].embeds[0].data.fields.find((field) => field.name === "Год").value).toBe("2024");
    expect(edits[0].embeds[0].data.fields.find((field) => field.name === "Ссылки").value).toContain("anidb.net");
  });
});
