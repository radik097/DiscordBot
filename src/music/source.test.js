import { describe, expect, test } from "bun:test";
import { parseStartTime, startTimeFromUrl } from "./source.js";

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
});
