const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const REQUEST_INTERVAL_MS = 2_100;
const CANDIDATE_CACHE_TTL_MS = 15 * 60 * 1_000;

const RANDOM_ANIME_QUERY = `
  query RandomAnimeCandidates($genre: String!, $startDate: FuzzyDateInt!, $endDate: FuzzyDateInt!) {
    Page(page: 1, perPage: 50) {
      media(
        type: ANIME
        genre: $genre
        startDate_greater: $startDate
        startDate_lesser: $endDate
        isAdult: false
        sort: [POPULARITY_DESC, SCORE_DESC]
      ) {
        id
        title { romaji english native }
        description(asHtml: false)
        startDate { year month day }
        episodes
        averageScore
        genres
        format
        status
        siteUrl
        coverImage { large color }
      }
    }
  }
`;

export class AnimeNotFoundError extends Error {}

export class AniListClient {
  constructor({
    fetchImpl = fetch,
    random = Math.random,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    requestIntervalMs = REQUEST_INTERVAL_MS,
    candidateCacheTtlMs = CANDIDATE_CACHE_TTL_MS,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.random = random;
    this.now = now;
    this.sleep = sleep;
    this.requestIntervalMs = requestIntervalMs;
    this.candidateCacheTtlMs = candidateCacheTtlMs;
    this.candidateCache = new Map();
    this.lastRequestStartedAt = 0;
    this.requestTail = Promise.resolve();
  }

  async requestCandidates(genre, startDate, endDate) {
    const run = this.requestTail.then(async () => {
      const waitMs = Math.max(0, this.lastRequestStartedAt + this.requestIntervalMs - this.now());
      if (waitMs) await this.sleep(waitMs);
      this.lastRequestStartedAt = this.now();

      const response = await this.fetchImpl(ANILIST_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query: RANDOM_ANIME_QUERY, variables: { genre, startDate, endDate } }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = response.headers?.get?.("retry-after");
          throw new Error(`AniList ограничил частоту запросов${retryAfter ? `; повторите через ${retryAfter} сек.` : "."}`);
        }
        throw new Error(`AniList вернул HTTP ${response.status}.`);
      }

      const payload = await response.json();
      if (payload.errors?.length) throw new Error(`AniList: ${payload.errors[0].message}`);
      if (!payload.data?.Page) throw new Error("AniList вернул неполный ответ.");
      return payload.data.Page;
    });

    this.requestTail = run.catch(() => {});
    return run;
  }

  async candidatesForYear(genre, year) {
    const cacheKey = `${genre.toLocaleLowerCase("en-US")}:${year}`;
    const cached = this.candidateCache.get(cacheKey);
    if (cached?.expiresAt > this.now()) return cached.candidates;

    const page = await this.requestCandidates(genre, (year - 1) * 10_000 + 1_231, (year + 1) * 10_000 + 101);
    const candidates = page.media ?? [];
    this.candidateCache.set(cacheKey, { candidates, expiresAt: this.now() + this.candidateCacheTtlMs });
    return candidates;
  }

  async findRandom({ genre, minYear }) {
    const normalizedGenre = String(genre ?? "").trim();
    const year = Number(minYear);
    const maxYear = new Date(this.now()).getUTCFullYear() + 1;
    if (!normalizedGenre) throw new TypeError("Жанр не указан.");
    if (!Number.isInteger(year) || year < 1917 || year > maxYear) {
      throw new TypeError(`Минимальный год должен быть от 1917 до ${maxYear}.`);
    }

    const years = Array.from({ length: maxYear - year + 1 }, (_, index) => year + index);
    const attempts = Math.min(4, years.length);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const yearIndex = Math.floor(Math.min(Math.max(this.random(), 0), 0.999999999999) * years.length);
      const selectedYear = years.splice(yearIndex, 1)[0];
      const candidates = await this.candidatesForYear(normalizedGenre, selectedYear);
      if (candidates.length) {
        const candidateIndex = Math.floor(Math.min(Math.max(this.random(), 0), 0.999999999999) * candidates.length);
        return candidates[candidateIndex];
      }
    }

    throw new AnimeNotFoundError("По этим фильтрам аниме не найдено. Попробуйте уменьшить минимальный год.");
  }
}

const defaultClient = new AniListClient();

export function findRandomAnime(filters) {
  return defaultClient.findRandom(filters);
}
