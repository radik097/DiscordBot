import { describe, expect, test } from "bun:test";
import { isSpotifyUrl, resolveSpotifyTrack } from "./spotifySource.js";

describe("Spotify music source", () => {
  test("recognizes public Spotify links", () => {
    expect(isSpotifyUrl("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT")).toBeTrue();
    expect(isSpotifyUrl("https://spotify.link/example")).toBeTrue();
    expect(isSpotifyUrl("https://example.com/track/4cOdK2wGLETKBW3PvgPWqT")).toBeFalse();
  });

  test("reads one track through the official oEmbed endpoint", async () => {
    let requested;
    const result = await resolveSpotifyTrack("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", {
      fetchImpl: async (url) => {
        requested = new URL(url);
        return Response.json({
          title: "Never Gonna Give You Up",
          thumbnail_url: "https://i.scdn.co/image/example",
          html: '<iframe src="https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT"></iframe>',
        });
      },
    });
    expect(requested.origin + requested.pathname).toBe("https://open.spotify.com/oembed");
    expect(requested.searchParams.get("url")).toContain("open.spotify.com/track/");
    expect(result.title).toBe("Never Gonna Give You Up");
  });

  test("rejects Spotify albums and playlists for single-track play", async () => {
    await expect(resolveSpotifyTrack("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"))
      .rejects.toThrow("один трек");
  });
});
