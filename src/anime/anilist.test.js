import { describe, expect, test } from "bun:test";
import { AniListClient, AnimeNotFoundError } from "./anilist.js";

function response(data) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

describe("AniList random anime selection", () => {
  test("selects a random year and candidate with genre and minimum year filters", async () => {
    const requests = [];
    const randomValues = [0, 0.5];
    const client = new AniListClient({
      random: () => randomValues.shift() ?? 0,
      now: () => Date.UTC(2024, 0, 1),
      requestIntervalMs: 0,
      fetchImpl: async (_url, options) => {
        const variables = JSON.parse(options.body).variables;
        requests.push(variables);
        return response({ Page: { media: [{ id: 1 }, { id: 2, title: { romaji: "Second" } }] } });
      },
    });

    const anime = await client.findRandom({ genre: "Action", minYear: 2020 });
    expect(anime.id).toBe(2);
    expect(requests).toEqual([{ genre: "Action", startDate: 20191231, endDate: 20210101 }]);
  });

  test("reuses cached candidates and reports empty filters", async () => {
    let calls = 0;
    const client = new AniListClient({
      random: () => 0,
      now: () => Date.UTC(2024, 0, 1),
      requestIntervalMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return response({ Page: { media: [{ id: 10 }] } });
      },
    });
    await client.findRandom({ genre: "Comedy", minYear: 2010 });
    await client.findRandom({ genre: "Comedy", minYear: 2010 });
    expect(calls).toBe(1);

    const empty = new AniListClient({
      random: () => 0,
      now: () => Date.UTC(2024, 0, 1),
      requestIntervalMs: 0,
      fetchImpl: async () => response({ Page: { media: [] } }),
    });
    await expect(empty.findRandom({ genre: "Horror", minYear: 2025 })).rejects.toBeInstanceOf(AnimeNotFoundError);
  });
});
