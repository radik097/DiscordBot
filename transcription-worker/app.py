import ctypes
import json
import math
import os
import subprocess
from pathlib import Path
from threading import Lock

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from faster_whisper import WhisperModel

DATA_ROOT = Path(os.getenv("TRANSCRIPTION_DATA_ROOT", "/data/transcriptions")).resolve()
MODEL_NAME = os.getenv("WHISPER_MODEL", "small")
MODEL_REVISION = os.getenv("WHISPER_MODEL_REVISION") or {
    "small": "536b0662742c02347bc0e980a01041f333bce120",
}.get(MODEL_NAME)
DEVICE = os.getenv("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "float16")
MODEL_CACHE = os.getenv("WHISPER_MODEL_CACHE", "/models")
SAMPLE_RATE = 16_000
FRAME_SAMPLES = 320
AEC_TAIL_SAMPLES = 4_800
AEC_MIN_CORRELATION = float(os.getenv("AEC_MIN_CORRELATION", "0.12"))

app = FastAPI(title="DiscordBot local transcription worker", docs_url=None, redoc_url=None)
model_lock = Lock()
model = None
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


def load_model():
    global model, model_error
    try:
        model = WhisperModel(
            MODEL_NAME,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
            download_root=MODEL_CACHE,
            local_files_only=os.getenv("WHISPER_LOCAL_FILES_ONLY", "0") == "1",
            revision=MODEL_REVISION,
        )
    except Exception as exc:  # health reports the exact local runtime problem
        model_error = str(exc)


load_model()


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


def transcribe_speaker(audio: np.ndarray, language_mode: str):
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
    segments, info = model.transcribe(audio, language=language, **options)
    segments = list(segments)
    if language_mode == "auto" and info.language not in ("ru", "en"):
        probabilities = dict(info.all_language_probs or [])
        language = "ru" if probabilities.get("ru", 0) >= probabilities.get("en", 0) else "en"
        segments, info = model.transcribe(audio, language=language, **options)
        segments = list(segments)
    return segments, info


@app.get("/health")
def health():
    if model is None:
        raise HTTPException(503, model_error or "model is not ready")
    return {
        "ready": True,
        "model": MODEL_NAME,
        "revision": MODEL_REVISION,
        "device": DEVICE,
        "computeType": COMPUTE_TYPE,
        "error": model_error,
    }


@app.post("/v1/chunks")
def transcribe_chunk(job: ChunkJob):
    if model is None:
        raise HTTPException(503, model_error or "model is not ready")
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
                segments, info = transcribe_speaker(cleaned, job.language)
                for segment in segments:
                    text = segment.text.strip()
                    if not text or round(segment.start * 1000) < job.keepFromMs:
                        continue
                    response_segments.append({
                        "speakerId": speaker.id,
                        "speakerName": speaker.name,
                        "startMs": round(segment.start * 1000),
                        "endMs": round(segment.end * 1000),
                        "text": text,
                        "language": info.language,
                        "confidence": max(0.0, min(1.0, math.exp(segment.avg_logprob))),
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
    }
