import { describe, expect, test } from "bun:test";
import { parseStartTime, playlistUrlFromQuery, resolveTrack, singleTrackQuery, startTimeFromUrl } from "./source.js";

describe("music timestamps", () => {
  test("parses numeric, clock, and YouTube duration timestamps", () => {
    expect(parseStartTime("90")).toBe(90);
    expect(parseStartTime("1:30")).toBe(90);
    expect(parseStartTime("1:02:03")).toBe(3723);
    expect(parseStartTime("1h2m3s")).toBe(3723);
    expect(parseStartTime("bad")).toBe(0);
  });

  test("reads t and start only from YouTube links", () => {
    expect(startTimeFromUrl("https://youtu.be/5M9zMQXItqM?t=2m10s")).toBe(130);
    expect(startTimeFromUrl("https://www.youtube.com/watch?v=5M9zMQXItqM&start=75")).toBe(75);
    expect(startTimeFromUrl("https://example.com/?t=90")).toBe(0);
  });

  test("accepts playlist identifiers only outside links-only mode", () => {
    const playlistId = "PL1234567890abcdef";
    expect(playlistUrlFromQuery(playlistId)).toContain(`list=${playlistId}`);
    expect(playlistUrlFromQuery(playlistId, { linksOnly: true })).toBeNull();
    expect(playlistUrlFromQuery(`https://www.youtube.com/playlist?list=${playlistId}`, { linksOnly: true }))
      .toContain(`list=${playlistId}`);
  });

  test("strips playlist context from a query video and rejects a playlist-only query", () => {
    expect(singleTrackQuery("https://www.youtube.com/watch?v=5M9zMQXItqM&list=PL1234567890abcdef&t=75"))
      .toBe("https://www.youtube.com/watch?v=5M9zMQXItqM&t=75");
    expect(() => singleTrackQuery("https://www.youtube.com/playlist?list=PL1234567890abcdef"))
      .toThrow("параметр `playlist`");
  });

  test("routes non-YouTube service links through Cobalt without changing text search", async () => {
    const calls = [];
    const track = await resolveTrack("https://soundcloud.com/artist/track", "tester", {
      cobaltResolver: async (url, requestedBy) => {
        calls.push({ url, requestedBy });
        return { sourceType: "cobalt", url, title: "Track", requestedBy };
      },
    });
    expect(track.sourceType).toBe("cobalt");
    expect(calls).toEqual([{ url: "https://soundcloud.com/artist/track", requestedBy: "tester" }]);
  });

  test("resolves a Spotify track to one YouTube audio match without calling Cobalt", async () => {
    let cobaltCalled = false;
    let searchQuery;
    const track = await resolveTrack("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", "tester", {
      cobaltResolver: async () => {
        cobaltCalled = true;
      },
      spotifyResolver: async (url) => ({ title: "Never Gonna Give You Up", sourceUrl: url }),
      spotifySearchImpl: async (query) => {
        searchQuery = query;
        return {
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          title: "Rick Astley - Never Gonna Give You Up",
          durationInSec: 213,
          thumbnails: [{ url: "https://i.ytimg.com/example.jpg" }],
        };
      },
    });
    expect(cobaltCalled).toBeFalse();
    expect(searchQuery).toBe("Never Gonna Give You Up official audio");
    expect(track).toMatchObject({
      sourceType: "spotify-match",
      sourceService: "spotify.com",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      requestedBy: "tester",
    });
  });
});
