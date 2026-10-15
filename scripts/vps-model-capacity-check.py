"""Install and smoke-test small Ollama models; never alter service defaults."""
import json
import base64
import pathlib
import struct
import sys
import time
import urllib.request
import zlib

BASE = "http://127.0.0.1:11434"
OUT = pathlib.Path.home() / "model-audit"
OUT.mkdir(exist_ok=True)


def request(path, payload=None, timeout=15):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)


def memory():
    keys = {"MemAvailable", "SwapFree"}
    return {line.split(":")[0]: int(line.split()[1]) for line in pathlib.Path("/proc/meminfo").read_text().splitlines() if line.split(":")[0] in keys}


model = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else "install"
before = json.load(request("/api/tags"))
if mode == "install":
    (OUT / (model.replace(":", "-") + "-before.json")).write_text(json.dumps(before, indent=2))
    print(json.dumps({"model": model, "stage": "download", "memory": memory()}), flush=True)
    with request("/api/pull", {"model": model, "stream": True}, 180) as response:
        last = 0
        for line in response:
            item = json.loads(line)
            if "error" in item:
                raise RuntimeError(item["error"])
            if time.monotonic() - last > 15 or item.get("status") == "success":
                print(json.dumps({k: item[k] for k in ("status", "completed", "total") if k in item}), flush=True)
                last = time.monotonic()
    print(json.dumps({"stage": "installed", "model": model}), flush=True)
elif mode in ("test", "vision"):
    if memory()["MemAvailable"] < 1700000:
        raise RuntimeError("Insufficient available memory for isolated smoke test")
    active = json.load(request("/api/ps"))["models"]
    if active:
        raise RuntimeError("Other models are loaded; avoid disturbing existing inference")
    show = json.load(request("/api/show", {"model": model}))
    payload = {"model": model, "messages": [{"role": "user", "content": "Quanto e 17 + 25? Responda somente com o numero."}], "stream": False, "keep_alive": 0, "options": {"num_ctx": 2048, "num_predict": 160, "num_thread": 2, "temperature": 0}}
    if model.startswith("qwen"):
        payload["think"] = False
    if mode == "vision":
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
        pixels = (b"\0" + bytes([255, 0, 0]) * 64) * 64
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")
        payload["messages"] = [{"role": "user", "content": "Qual a cor principal da imagem? Responda uma palavra em portugues.", "images": [base64.b64encode(png).decode()]}]
        payload["options"]["num_predict"] = 24
    start = time.monotonic()
    try:
        result = json.load(request("/api/chat", payload, 240))
        record = {"model": model, "mode": mode, "capabilities": show.get("capabilities"), "elapsedSeconds": round(time.monotonic() - start, 2), "done": result.get("done"), "doneReason": result.get("done_reason"), "answer": result.get("message", {}).get("content"), "evalCount": result.get("eval_count"), "evalDuration": result.get("eval_duration"), "memoryAfter": memory()}
        (OUT / (model.replace(":", "-") + "-" + mode + ".json")).write_text(json.dumps(record, indent=2))
        print(json.dumps(record), flush=True)
    except Exception as error:
        record = {"model": model, "mode": mode, "error": str(error), "elapsedSeconds": round(time.monotonic() - start, 2)}
        (OUT / (model.replace(":", "-") + "-" + mode + ".json")).write_text(json.dumps(record, indent=2))
        print(json.dumps(record), flush=True)
        raise
