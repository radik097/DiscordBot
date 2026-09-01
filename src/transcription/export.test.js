import { describe, expect, test } from "bun:test";
import { exportTranscript, formatTranscriptTimestamp, transcriptFilename } from "./export.js";

describe("transcription export", () => {
  const session = { id: "session-1", startedAt: Date.UTC(2026, 8, 1), status: "completed", language: "auto" };
  const segments = [
    { id: 2, speakerName: "Боб", startMs: 5100, endMs: 8200, text: "Вторая реплика" },
    { id: 1, speakerName: "Алиса", startMs: 1200, endMs: 4600, text: "Первая реплика" },
  ];

  test("formats deterministic TXT with speakers and timestamps", () => {
    const text = exportTranscript(session, segments, "txt");
    expect(text).toContain("[00:00:01.200–00:00:04.600] Алиса: Первая реплика");
    expect(text.indexOf("Алиса")).toBeLessThan(text.indexOf("Боб"));
    expect(formatTranscriptTimestamp(3_661_007)).toBe("01:01:01.007");
  });

  test("formats SRT and marks partial filenames", () => {
    const srt = exportTranscript(session, segments, "srt");
    expect(srt).toContain("00:00:01,200 --> 00:00:04,600");
    expect(srt).toContain("Алиса: Первая реплика");
    expect(transcriptFilename(session, "srt", true)).toEndWith(".partial.srt");
  });
});
