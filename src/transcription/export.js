function pad(value, width = 2) {
  return String(Math.max(0, Math.floor(value))).padStart(width, "0");
}

export function formatTranscriptTimestamp(milliseconds, separator = ".") {
  const total = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`;
}

export function exportTranscript(session, segments, format = "txt", { partial = false } = {}) {
  const normalized = String(format || "txt").toLowerCase();
  if (!['txt', 'srt'].includes(normalized)) throw new Error("Формат экспорта должен быть TXT или SRT.");
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id - b.id);
  if (normalized === "srt") {
    const body = ordered.map((segment, index) => [
      index + 1,
      `${formatTranscriptTimestamp(segment.startMs, ",")} --> ${formatTranscriptTimestamp(Math.max(segment.endMs, segment.startMs + 1), ",")}`,
      `${segment.speakerName}: ${segment.text}`,
    ].join("\n")).join("\n\n");
    return `${body}${body ? "\n" : ""}`;
  }
  const header = [
    `Транскрипция Discord · ${session.id}`,
    `Начало: ${new Date(session.startedAt).toISOString()}`,
    `Статус: ${partial ? "черновик" : session.status}`,
    `Язык: ${session.language}`,
    "",
  ];
  const lines = ordered.map((segment) =>
    `[${formatTranscriptTimestamp(segment.startMs)}–${formatTranscriptTimestamp(segment.endMs)}] ${segment.speakerName}: ${segment.text}`
  );
  return [...header, ...lines, ""].join("\n");
}

export function transcriptFilename(session, format = "txt", partial = false) {
  const stamp = new Date(session.startedAt).toISOString().replace(/[:.]/g, "-");
  return `discord-transcript-${stamp}${partial ? ".partial" : ""}.${format}`;
}
