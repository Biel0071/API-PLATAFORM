import base64
import io
import os
import subprocess
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="API Platform Local Open-Source Audio Engine")
MODEL_DIR = Path(os.getenv("AUDIO_MODEL_DIR", "/models"))

AVAILABLE_VOICES = [
    {"id": "pf_dora", "name": "Kokoro · Dora (PT-BR Feminina)", "lang": "pt-br", "espeak": "pt-br+f3"},
    {"id": "pm_alex", "name": "Kokoro · Alex (PT-BR Masculina)", "lang": "pt-br", "espeak": "pt-br+m3"},
    {"id": "pm_santa", "name": "Kokoro · Narrador (PT-BR Grave)", "lang": "pt-br", "espeak": "pt-br+m1"},
    {"id": "af_heart", "name": "Kokoro · Heart (EN Studio)", "lang": "en-us", "espeak": "en-us+f3"},
    {"id": "af_bella", "name": "Kokoro · Bella (EN Expressiva)", "lang": "en-us", "espeak": "en-us+f4"},
    {"id": "am_adam", "name": "Kokoro · Adam (EN Masculina)", "lang": "en-us", "espeak": "en-us+m3"},
]

VOICE_PROFILES = {
    "natural": [],
    "studio_warm": ["bass=g=3:f=120:w=0.6", "treble=g=2:f=6500:w=0.5", "acompressor=threshold=-18dB:ratio=2.5:makeup=2dB"],
    "deep_voice": ["asetrate=24000*0.88", "aresample=24000", "atempo=1.136", "bass=g=5:f=110:w=0.7"],
    "bright_clear": ["asetrate=24000*1.08", "aresample=24000", "atempo=0.926", "treble=g=4:f=5000:w=0.6"],
    "radio": ["highpass=f=90", "lowpass=f=11000", "acompressor=threshold=-16dB:ratio=4:makeup=4dB", "bass=g=4:f=130:w=0.6"],
}


class Transcription(BaseModel):
    audio: str = Field(min_length=1, max_length=26_000_000)
    language: str = Field(default="pt", min_length=2, max_length=16)


class Speech(BaseModel):
    text: str = Field(min_length=1, max_length=10_000)
    voice: str = Field(default="pf_dora", min_length=1, max_length=128)
    profile: str = Field(default="natural", min_length=1, max_length=64)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


class VoiceTransform(BaseModel):
    audio: str = Field(min_length=1, max_length=26_000_000)
    voice: str = Field(default="pf_dora", min_length=1, max_length=128)
    profile: str = Field(default="natural", min_length=1, max_length=64)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    language: str = Field(default="pt", min_length=2, max_length=16)


_WHISPER = None
_KOKORO = None
_INFERENCE_LOCK = threading.Lock()


def _has_kokoro_weights() -> bool:
    return (MODEL_DIR / "kokoro-v1.0.onnx").is_file() and (MODEL_DIR / "voices-v1.0.bin").is_file()


def _has_espeak() -> bool:
    try:
        subprocess.run(["espeak-ng", "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=3)
        return True
    except Exception:
        return False


def _has_whisper_module() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


@app.get("/health")
def health():
    tts_kokoro = _has_kokoro_weights()
    tts_espeak = _has_espeak()
    tts_ready = tts_kokoro or tts_espeak
    whisper_model = os.getenv("WHISPER_MODEL", "base")
    whisper_cache = MODEL_DIR / "whisper" / ("models--Systran--faster-whisper-" + whisper_model)
    whisper_cached = whisper_cache.is_dir() and any(whisper_cache.glob("snapshots/*/model.bin"))
    stt_ready = _WHISPER is not None or whisper_cached or _has_whisper_module()
    return {
        "status": "ready" if tts_ready and stt_ready else "degraded",
        "sttLoaded": _WHISPER is not None or whisper_cached,
        "ttsFilesPresent": tts_kokoro,
        "stt": {"ready": stt_ready, "loaded": _WHISPER is not None, "model": f"faster-whisper-{whisper_model}"},
        "tts": {
            "ready": tts_ready,
            "engine": "kokoro-82m-onnx" if tts_kokoro else "espeak-ng-dsp",
            "model": "kokoro-82m-onnx-pt-br" if tts_kokoro else "espeak-ng-neural-dsp",
        },
        "voices": AVAILABLE_VOICES,
        "profiles": list(VOICE_PROFILES.keys()),
        "cloning": {"ready": True, "mode": "speech-to-speech-transform"},
    }


def _load_whisper():
    global _WHISPER
    if _WHISPER is None:
        from faster_whisper import WhisperModel
        model_name = os.getenv("WHISPER_MODEL", "base")
        cache_dir = MODEL_DIR / "whisper"
        cache_dir.mkdir(parents=True, exist_ok=True)
        _WHISPER = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=2, download_root=str(cache_dir))
    return _WHISPER


def _load_kokoro(lang: str = "pt-br"):
    global _KOKORO
    model = MODEL_DIR / "kokoro-v1.0.onnx"
    voices = MODEL_DIR / "voices-v1.0.bin"
    if not model.is_file() or not voices.is_file():
        return None
    from kokoro_onnx import Kokoro
    from misaki.espeak import EspeakG2P
    if _KOKORO is None:
        _KOKORO = Kokoro(str(model), str(voices))
    return _KOKORO, EspeakG2P(language=lang)


def _apply_dsp_filters(wav_bytes: bytes, profile: str = "natural", speed: float = 1.0) -> bytes:
    filters = list(VOICE_PROFILES.get(profile, []))
    if abs(speed - 1.0) > 0.03:
        clamped = max(0.5, min(2.0, float(speed)))
        filters.append(f"atempo={clamped:.3f}")
    if not filters:
        return wav_bytes
    with tempfile.NamedTemporaryFile(suffix=".in.wav", delete=False) as fin:
        fin.write(wav_bytes)
        in_path = fin.name
    out_path = in_path + ".out.wav"
    try:
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", in_path, "-af", ",".join(filters), "-ar", "24000", "-ac", "1", out_path],
            check=True,
            timeout=60,
        )
        return Path(out_path).read_bytes()
    finally:
        if os.path.exists(in_path):
            os.unlink(in_path)
        if os.path.exists(out_path):
            os.unlink(out_path)


def _synthesize_wav(text: str, voice: str = "pf_dora", profile: str = "natural", speed: float = 1.0) -> tuple[bytes, str]:
    voice_meta = next((v for v in AVAILABLE_VOICES if v["id"] == voice), AVAILABLE_VOICES[0])
    with _INFERENCE_LOCK:
        kokoro_pair = _load_kokoro(voice_meta["lang"])
        if kokoro_pair is not None:
            import soundfile as sf
            kokoro, g2p = kokoro_pair
            phonemes, _ = g2p(text)
            samples, sample_rate = kokoro.create(phonemes, voice=voice_meta["id"], speed=float(speed), is_phonemes=True)
            buffer = io.BytesIO()
            sf.write(buffer, samples, sample_rate, format="WAV")
            raw_wav = buffer.getvalue()
            return _apply_dsp_filters(raw_wav, profile=profile, speed=1.0), "kokoro-82m-onnx-pt-br"

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            wpm = max(110, min(260, int(165 * float(speed))))
            pitch = "38" if voice == "pm_santa" else ("44" if voice.startswith(("pm_", "am_")) else "58")
            subprocess.run(
                ["espeak-ng", "-v", voice_meta["espeak"], "-s", str(wpm), "-p", pitch, "-w", tmp_path, text],
                check=True,
                timeout=60,
            )
            raw_wav = Path(tmp_path).read_bytes()
            return _apply_dsp_filters(raw_wav, profile=profile, speed=1.0), "espeak-ng-neural-dsp"
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)


def _transcribe_audio_bytes(raw: bytes, language: str = "pt") -> tuple[str, str]:
    if not raw or len(raw) > 18 * 1024 * 1024:
        raise ValueError("arquivo vazio ou acima de 18 MiB")
    with tempfile.NamedTemporaryFile(suffix=".upload", delete=False) as f:
        f.write(raw)
        source = f.name
    normalized = source + ".wav"
    try:
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", source, "-ac", "1", "-ar", "16000", normalized], check=True, timeout=120)
        with _INFERENCE_LOCK:
            segments, info = _load_whisper().transcribe(normalized, language=language, beam_size=1, vad_filter=True)
            text = " ".join(segment.text.strip() for segment in segments).strip()
        return text, info.language
    finally:
        if os.path.exists(source):
            os.unlink(source)
        if os.path.exists(normalized):
            os.unlink(normalized)


@app.post("/transcribe")
def transcribe(data: Transcription):
    try:
        raw = base64.b64decode(data.audio.split(",")[-1], validate=True)
        text, detected_lang = _transcribe_audio_bytes(raw, data.language)
        return {"text": text, "language": detected_lang, "model": "faster-whisper-" + os.getenv("WHISPER_MODEL", "base")}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Falha na transcricao local") from exc


@app.post("/speech")
def speech(data: Speech):
    try:
        wav_bytes, model_used = _synthesize_wav(data.text, voice=data.voice, profile=data.profile, speed=data.speed)
        return {
            "audio": base64.b64encode(wav_bytes).decode("ascii"),
            "mimeType": "audio/wav",
            "voice": data.voice,
            "profile": data.profile,
            "speed": data.speed,
            "model": model_used,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Falha na geracao local de fala") from exc


@app.post("/transform")
def transform_voice(data: VoiceTransform):
    try:
        raw = base64.b64decode(data.audio.split(",")[-1], validate=True)
        transcript = ""
        try:
            transcript, _ = _transcribe_audio_bytes(raw, data.language)
        except Exception:
            transcript = ""
        if transcript.strip():
            wav_bytes, model_used = _synthesize_wav(transcript, voice=data.voice, profile=data.profile, speed=data.speed)
            return {
                "audio": base64.b64encode(wav_bytes).decode("ascii"),
                "mimeType": "audio/wav",
                "transcript": transcript,
                "voice": data.voice,
                "profile": data.profile,
                "speed": data.speed,
                "model": f"sts-{model_used}",
            }
        # Fallback: modulação acústica direta sobre o áudio original se não houver fala detectável
        with tempfile.NamedTemporaryFile(suffix=".in", delete=False) as f:
            f.write(raw)
            src = f.name
        wav_norm = src + ".wav"
        try:
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src, "-ar", "24000", "-ac", "1", wav_norm], check=True, timeout=60)
            transformed = _apply_dsp_filters(Path(wav_norm).read_bytes(), profile=data.profile if data.profile != "natural" else "studio_warm", speed=data.speed)
            return {
                "audio": base64.b64encode(transformed).decode("ascii"),
                "mimeType": "audio/wav",
                "transcript": "(modulação acústica direta)",
                "voice": data.voice,
                "profile": data.profile,
                "speed": data.speed,
                "model": "ffmpeg-acoustic-dsp",
            }
        finally:
            if os.path.exists(src):
                os.unlink(src)
            if os.path.exists(wav_norm):
                os.unlink(wav_norm)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Falha na transformacao local de voz") from exc
