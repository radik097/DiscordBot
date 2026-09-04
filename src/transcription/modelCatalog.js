const PROVIDERS = Object.freeze({
  local: Object.freeze({
    id: "local",
    label: "Локальный faster-whisper",
    cloud: false,
    models: Object.freeze([
      { id: "tiny", label: "Whisper Tiny", note: "самая быстрая" },
      { id: "base", label: "Whisper Base", note: "быстрая" },
      { id: "small", label: "Whisper Small", note: "рекомендуется" },
      { id: "medium", label: "Whisper Medium", note: "точнее, требует больше VRAM" },
      { id: "large-v3", label: "Whisper Large v3", note: "максимальная точность" },
      { id: "distil-large-v3", label: "Distil Large v3", note: "быстрее Large v3" },
    ]),
  }),
  openai: Object.freeze({
    id: "openai",
    label: "OpenAI",
    cloud: true,
    models: Object.freeze([
      { id: "gpt-4o-mini-transcribe", label: "GPT-4o mini Transcribe", note: "рекомендуется" },
      { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe", note: "повышенная точность" },
      { id: "whisper-1", label: "Whisper API", note: "совместимая модель" },
    ]),
  }),
  mistral: Object.freeze({
    id: "mistral",
    label: "Mistral",
    cloud: true,
    models: Object.freeze([
      { id: "voxtral-mini-transcribe-realtime-2602", label: "Voxtral Mini Realtime", note: "живые субтитры + batch-финализация" },
      { id: "voxtral-mini-latest", label: "Voxtral Mini Transcribe", note: "актуальная batch-модель" },
    ]),
  }),
});

export const DEFAULT_TRANSCRIPTION_PROVIDER = "local";
export const DEFAULT_TRANSCRIPTION_MODEL = "small";

export function transcriptionCatalog() {
  return Object.values(PROVIDERS).map((provider) => ({
    id: provider.id,
    label: provider.label,
    cloud: provider.cloud,
    models: provider.models.map((model) => ({ ...model })),
  }));
}

export function normalizeTranscriptionProfile(providerValue, modelValue) {
  const provider = String(providerValue || DEFAULT_TRANSCRIPTION_PROVIDER).trim().toLowerCase();
  const definition = PROVIDERS[provider];
  if (!definition) throw new Error("Провайдер транскрипции должен быть local, openai или mistral.");
  const requested = String(modelValue || (provider === "local" ? DEFAULT_TRANSCRIPTION_MODEL : definition.models[0].id)).trim();
  const model = definition.models.find((candidate) => candidate.id === requested);
  if (!model) throw new Error(`Модель ${requested || "не указана"} недоступна для провайдера ${provider}.`);
  return { provider, model: model.id, cloud: definition.cloud };
}

export function modelChoicesForDiscord() {
  return Object.values(PROVIDERS).flatMap((provider) => provider.models.map((model) => ({
    name: `${provider.label}: ${model.label}`.slice(0, 100),
    value: `${provider.id}:${model.id}`,
  })));
}
