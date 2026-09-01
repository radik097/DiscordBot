import ctypes
import gc
import io
import json
import math
import os
import subprocess
import wave
from pathlib import Path
from threading import Lock

import numpy as np
import requests
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from faster_whisper import WhisperModel

DATA_ROOT = Path(os.getenv("TRANSCRIPTION_DATA_ROOT", "/data/transcriptions")).resolve()
DEFAULT_MODEL = os.getenv("WHISPER_MODEL", "small")
DEFAULT_MODEL_REVISION = os.getenv("WHISPER_MODEL_REVISION") or {
    "small": "536b0662742c02347bc0e980a01041f333bce120",
}.get(DEFAULT_MODEL)
DEVICE = os.getenv("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "float16")
MODEL_CACHE = os.getenv("WHISPER_MODEL_CACHE", "/models")
LOCAL_MODELS = {"tiny", "base", "small", "medium", "large-v3", "distil-large-v3"}
CLOUD_MODELS = {
    "openai": {"gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"},
    "mistral": {"voxtral-mini-latest"},
}
CLOUD_ENDPOINTS = {
    "openai": "https://api.openai.com/v1/audio/transcriptions",
    "mistral": "https://api.mistral.ai/v1/audio/transcriptions",
}
CLOUD_TIMEOUT = max(30, int(os.getenv("TRANSCRIPTION_CLOUD_TIMEOUT_SECONDS", "180")))
SAMPLE_RATE = 16_000
FRAME_SAMPLES = 320
AEC_TAIL_SAMPLES = 4_800
AEC_MIN_CORRELATION = float(os.getenv("AEC_MIN_CORRELATION", "0.12"))

app = FastAPI(title="DiscordBot local transcription worker", docs_url=None, redoc_url=None)
model_lock = Lock()
model = None
loaded_model_name = None
model_error = None


class Speaker(BaseModel):
    id: str = Field(pattern=r"^[0-9]{1,32}$")
    name: str = Field(min_length=1, max_length=128)
    file: str = Field(min_length=1, max_length=512)


class ChunkJob(BaseModel):
    sessionId: str = Field(pattern=r"^[0-9a-f-]{36}$")
    chunkId: str = Field(pattern=r"^[0-9a-f-]{36}$")
    chunkIndex: int = Field(ge=0)
    startMs: int = Field(ge=0)
    endMs: int = Field(gt=0)
    keepFromMs: int = Field(default=0, ge=0, le=15_000)
    language: str = Field(pattern=r"^(auto|ru|en)$")
    speakers: list[Speaker]
    referenceFile: str | None = None
    root: str | None = None


class ModelRequest(BaseModel):
    provider: str = Field(pattern=r"^(local|openai|mistral)$")
    model: str = Field(min_length=1, max_length=128)


def validate_profile(provider: str, model_name: str):
    if provider == "local":
        if model_name not in LOCAL_MODELS:
            raise HTTPException(400, "unsupported local transcription model")
        return
    if provider not in CLOUD_MODELS or model_name not in CLOUD_MODELS[provider]:
        raise HTTPException(400, "unsupported cloud transcription model")


def bearer_key(request: Request) -> str:
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer "):
        return ""
    return authorization[7:].strip()


def ensure_local_model(model_name: str):
    global model, loaded_model_name, model_error
    validate_profile("local", model_name)
    if model is not None and loaded_model_name == model_name:
        return model
    if model is not None:
        model = None
        loaded_model_name = None
        gc.collect()
    try:
        model = WhisperModel(
            model_name,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
            download_root=MODEL_CACHE,
            local_files_only=os.getenv("WHISPER_LOCAL_FILES_ONLY", "0") == "1",
            revision=DEFAULT_MODEL_REVISION if model_name == DEFAULT_MODEL else None,
        )
        loaded_model_name = model_name
        model_error = None
        return model
    except Exception as exc:  # health reports the exact local runtime problem
        model_error = str(exc)
        model = None
        loaded_model_name = None
        raise


def safe_path(relative_path: str) -> Path:
    path = (DATA_ROOT / relative_path).resolve()
    if path != DATA_ROOT and DATA_ROOT not in path.parents:
        raise HTTPException(400, "path escapes transcription storage")
    return path


def decode_audio_file(path: Path) -> np.ndarray:
    if path.suffix == ".s16le":
        pcm = np.fromfile(path, dtype="<i2")
    else:
        process = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-i", str(path), "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"],
            check=True, stdout=subprocess.PIPE,
        )
        pcm = np.frombuffer(process.stdout, dtype="<i2")
    if pcm.size < 2:
        return np.zeros(0, dtype=np.float32)
    stereo = pcm[: pcm.size - pcm.size % 2].reshape(-1, 2).astype(np.float32).mean(axis=1)
    # 48 kHz -> 16 kHz: short symmetric FIR before exact-factor decimation.
    filtered = np.convolve(stereo, np.array([1, 2, 3, 2, 1], dtype=np.float32) / 9.0, mode="same")
    return np.clip(filtered[::3] / 32768.0, -1.0, 1.0).astype(np.float32)


def existing_audio_path(path: Path) -> Path:
    if path.exists():
        return path
    archived = path.with_suffix(".flac") if path.suffix == ".s16le" else path
    return archived if archived.exists() else path


def rms(audio: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(audio), dtype=np.float64))) if audio.size else 0.0


def align_reference(microphone: np.ndarray, reference: np.ndarray, max_delay_s: float = 3.0):
    length = min(microphone.size, reference.size)
    if length < SAMPLE_RATE or rms(reference[:length]) < 0.002:
        return reference[:length], 0.0, 0
    mic = microphone[:length] - float(np.mean(microphone[:length]))
    ref = reference[:length] - float(np.mean(reference[:length]))
    stride = 8
    mic_small = mic[::stride]
    ref_small = ref[::stride]
    n = 1 << math.ceil(math.log2(mic_small.size + ref_small.size - 1))
    circular = np.fft.irfft(np.fft.rfft(mic_small, n) * np.conj(np.fft.rfft(ref_small, n)), n)
    max_lag = min(int(max_delay_s * SAMPLE_RATE / stride), mic_small.size - 1)
    values = np.concatenate((circular[-max_lag:], circular[: max_lag + 1]))
    lags = np.arange(-max_lag, max_lag + 1)
    lag_small = int(lags[int(np.argmax(np.abs(values)))])
    lag = lag_small * stride
    aligned = np.zeros(length, dtype=np.float32)
    if lag >= 0:
        aligned[lag:] = ref[: length - lag]
    else:
        aligned[:lag] = ref[-lag:]
    denom = math.sqrt(float(np.dot(mic, mic)) * float(np.dot(aligned, aligned))) + 1e-12
    confidence = abs(float(np.dot(mic, aligned))) / denom
    return aligned, min(1.0, confidence), lag


def speex_aec(microphone: np.ndarray, reference: np.ndarray) -> np.ndarray:
    library = ctypes.CDLL("libspeexdsp.so.1")
    library.speex_echo_state_init.restype = ctypes.c_void_p
    state = library.speex_echo_state_init(FRAME_SAMPLES, AEC_TAIL_SAMPLES)
    if not state:
        raise RuntimeError("SpeexDSP could not create echo state")
    rate = ctypes.c_int(SAMPLE_RATE)
    library.speex_echo_ctl(ctypes.c_void_p(state), 24, ctypes.byref(rate))
    count = min(microphone.size, reference.size)
    padded = int(math.ceil(count / FRAME_SAMPLES) * FRAME_SAMPLES)
    mic = np.zeros(padded, dtype=np.int16)
    ref = np.zeros(padded, dtype=np.int16)
    mic[:count] = np.clip(microphone[:count] * 32767, -32768, 32767).astype(np.int16)
    ref[:count] = np.clip(reference[:count] * 32767, -32768, 32767).astype(np.int16)
    output = np.zeros(padded, dtype=np.int16)
    try:
        pointer = ctypes.POINTER(ctypes.c_int16)
        for start in range(0, padded, FRAME_SAMPLES):
            library.speex_echo_cancellation(
                ctypes.c_void_p(state),
                mic[start:].ctypes.data_as(pointer),
                ref[start:].ctypes.data_as(pointer),
                output[start:].ctypes.data_as(pointer),
            )
    finally:
        library.speex_echo_state_destroy(ctypes.c_void_p(state))
    return output[:count].astype(np.float32) / 32768.0


def archive_lossless(path: Path) -> str:
    if path.suffix != ".s16le" or not path.exists():
        return str(path.relative_to(DATA_ROOT)).replace("\\", "/")
    target = path.with_suffix(".flac")
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "2",
        "-i", str(path), "-c:a", "flac", str(target),
    ], check=True)
    path.unlink()
    return str(target.relative_to(DATA_ROOT)).replace("\\", "/")


def transcribe_local(audio: np.ndarray, language_mode: str, local_model):
    options = dict(
        vad_filter=True,
        vad_parameters={
            "threshold": 0.5,
            "min_speech_duration_ms": 200,
            "min_silence_duration_ms": 500,
            "speech_pad_ms": 200,
        },
        word_timestamps=True,
        condition_on_previous_text=False,
        beam_size=5,
    )
    language = None if language_mode == "auto" else language_mode
    segments, info = local_model.transcribe(audio, language=language, **options)
    segments = list(segments)
    if language_mode == "auto" and info.language not in ("ru", "en"):
        probabilities = dict(info.all_language_probs or [])
        language = "ru" if probabilities.get("ru", 0) >= probabilities.get("en", 0) else "en"
        segments, info = local_model.transcribe(audio, language=language, **options)
        segments = list(segments)
    return [{
        "startMs": round(segment.start * 1000),
        "endMs": round(segment.end * 1000),
        "text": segment.text.strip(),
        "language": info.language,
        "confidence": max(0.0, min(1.0, math.exp(segment.avg_logprob))),
    } for segment in segments if segment.text.strip()]


def wav_bytes(audio: np.ndarray) -> bytes:
    output = io.BytesIO()
    pcm = np.clip(audio * 32767, -32768, 32767).astype("<i2")
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(SAMPLE_RATE)
        writer.writeframes(pcm.tobytes())
    return output.getvalue()


def transcribe_cloud(audio: np.ndarray, language_mode: str, provider: str, model_name: str, api_key: str):
    validate_profile(provider, model_name)
    if not api_key:
        raise HTTPException(400, "cloud provider API key is required")
    data = {"model": model_name, "response_format": "json"}
    if language_mode != "auto":
        data["language"] = language_mode
    try:
        response = requests.post(
            CLOUD_ENDPOINTS[provider],
            headers={"Authorization": f"Bearer {api_key}"},
            data=data,
            files={"file": ("speaker.wav", wav_bytes(audio), "audio/wav")},
            timeout=CLOUD_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise HTTPException(502, f"{provider} transcription request failed") from exc
    if not response.ok:
        raise HTTPException(502, f"{provider} transcription HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(502, f"{provider} returned invalid JSON") from exc
    language = payload.get("language") or (language_mode if language_mode != "auto" else None)
    result = []
    for segment in payload.get("segments") or []:
        text = str(segment.get("text") or "").strip()
        if not text:
            continue
        result.append({
            "startMs": round(float(segment.get("start") or 0) * 1000),
            "endMs": round(float(segment.get("end") or 0) * 1000),
            "text": text,
            "language": segment.get("language") or language,
            "confidence": None,
        })
    text = str(payload.get("text") or "").strip()
    if not result and text:
        result.append({
            "startMs": 0,
            "endMs": round(audio.size / SAMPLE_RATE * 1000),
            "text": text,
            "language": language,
            "confidence": None,
            "coarse": True,
        })
    return result


@app.get("/health")
def health():
    return {
        "ready": True,
        "defaultModel": DEFAULT_MODEL,
        "loadedModel": loaded_model_name,
        "revision": DEFAULT_MODEL_REVISION if loaded_model_name == DEFAULT_MODEL else None,
        "device": DEVICE,
        "computeType": COMPUTE_TYPE,
        "error": model_error,
    }


@app.post("/v1/models/install")
def install_model(selection: ModelRequest, request: Request):
    validate_profile(selection.provider, selection.model)
    if selection.provider != "local":
        if not bearer_key(request):
            raise HTTPException(400, "cloud provider API key is required")
        return {"ready": True, "provider": selection.provider, "model": selection.model, "installed": False}
    with model_lock:
        ensure_local_model(selection.model)
    return {"ready": True, "provider": "local", "model": selection.model, "installed": True}


@app.post("/v1/chunks")
def transcribe_chunk(job: ChunkJob, request: Request):
    provider = request.headers.get("x-transcription-provider", "local").strip().lower()
    model_name = request.headers.get("x-transcription-model", DEFAULT_MODEL).strip()
    validate_profile(provider, model_name)
    api_key = bearer_key(request) if provider != "local" else ""
    speaker_paths = [
        (speaker, existing_audio_path(safe_path(speaker.file)))
        for speaker in job.speakers
    ]
    missing_speakers = [speaker.file for speaker, path in speaker_paths if not path.exists()]
    if missing_speakers:
        missing = ", ".join(missing_speakers)
        raise HTTPException(422, f"speaker audio files are unavailable: {missing}")
    reference = None
    reference_path = existing_audio_path(safe_path(job.referenceFile)) if job.referenceFile else None
    if reference_path and reference_path.exists():
        reference = decode_audio_file(reference_path)
    response_segments = []
    aec_scores = []
    archived_speakers = []
    with model_lock:
        local_model = ensure_local_model(model_name) if provider == "local" else None
        for speaker, path in speaker_paths:
            microphone = decode_audio_file(path)
            cleaned = microphone
            aec_applied = False
            aec_confidence = 0.0
            if reference is not None and reference.size and microphone.size:
                aligned, aec_confidence, _lag = align_reference(microphone, reference)
                if aec_confidence >= AEC_MIN_CORRELATION:
                    try:
                        cleaned = speex_aec(microphone[: aligned.size], aligned)
                        aec_applied = True
                    except Exception:
                        cleaned = microphone  # preserve speech on any AEC uncertainty
                        aec_applied = False
            aec_scores.append(aec_confidence)
            if cleaned.size and rms(cleaned) > 0.0005:
                if provider == "local":
                    segments = transcribe_local(cleaned, job.language, local_model)
                else:
                    cloud_offset_samples = round(job.keepFromMs / 1000 * SAMPLE_RATE)
                    cloud_audio = cleaned[cloud_offset_samples:]
                    segments = transcribe_cloud(cloud_audio, job.language, provider, model_name, api_key) if cloud_audio.size else []
                    for segment in segments:
                        segment["startMs"] += job.keepFromMs
                        segment["endMs"] += job.keepFromMs
                for segment in segments:
                    segment = dict(segment)
                    if segment["startMs"] < job.keepFromMs and segment.pop("coarse", False):
                        segment["startMs"] = min(job.keepFromMs, segment["endMs"])
                    if not segment["text"] or segment["startMs"] < job.keepFromMs or segment["endMs"] <= segment["startMs"]:
                        continue
                    segment.pop("coarse", None)
                    response_segments.append({
                        "speakerId": speaker.id,
                        "speakerName": speaker.name,
                        **segment,
                        "aecApplied": aec_applied,
                        "aecConfidence": aec_confidence,
                    })
            archived_speakers.append({**speaker.model_dump(), "file": archive_lossless(path)})
        archived_reference = archive_lossless(reference_path) if reference_path and reference_path.exists() else None

    response_segments.sort(key=lambda item: (item["startMs"], item["endMs"], item["speakerId"]))
    job_file = safe_path(f"{job.sessionId}/chunk-{job.chunkIndex:06d}/job.json")
    if job_file.exists():
        stored = job.model_dump()
        stored["speakers"] = archived_speakers
        stored["referenceFile"] = archived_reference
        stored.pop("root", None)
        job_file.write_text(json.dumps(stored, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "segments": response_segments,
        "aecConfidence": max(aec_scores, default=0.0),
        "speakerCount": len(job.speakers),
        "provider": provider,
        "model": model_name,
    }
