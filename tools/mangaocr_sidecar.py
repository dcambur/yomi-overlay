#!/usr/bin/env python3
"""Tier-2 recognizer sidecar — INTEGRATION.md Phase 3.

Long-running process hosting manga-ocr (kha-white/manga-ocr-base) on PyTorch
MPS. Speaks NDJSON over stdin/stdout, one request per line:

    request:  {"id": 1, "image": "/path/crop.png"}
    reply:    {"id": 1, "text": "...", "ms": 412}
    error:    {"id": 1, "error": "...", "ms": 3}

stdout carries data only; diagnostics go to stderr. The model loads once at
startup (the whole point of staying resident — load is seconds, inference is
sub-second); "ready" is signalled by {"ready": true, "device": "mps"} on
stdout so the supervisor can distinguish "loading" from "hung".

manga-ocr reads a whole multi-line crop in one pass, both orientations, no
line splitting — but emits NO geometry and NO confidence (text only, by
design). Geometry stays with the caller's engines; this process is a second
OPINION, initially consumed in shadow mode (logged, not shown).

Run from the overlay venv: .venv/bin/python mangaocr_sidecar.py
Exit codes: 2 = import failed (not installed), 3 = model load failed.
"""

import json
import sys
import time


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(f"mangaocr: {msg}\n")
    sys.stderr.flush()


def main():
    t0 = time.time()
    try:
        import torch
        from manga_ocr import MangaOcr
    except Exception as e:  # not installed / broken venv — supervisor disables tier2
        log(f"import failed: {e}")
        sys.exit(2)

    # Explicit MPS override: upstream has no device wiring (issue open since
    # 2023); the community wrapper proves it works. CPU fallback is honest —
    # slower, still correct.
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    try:
        mocr = MangaOcr()
        if device == "mps":
            try:
                mocr.model.to(device)
            except Exception as e:
                log(f"mps move failed ({e}); staying on cpu")
                device = "cpu"
    except Exception as e:
        log(f"model load failed: {e}")
        sys.exit(3)
    log(f"model ready on {device} in {time.time() - t0:.1f}s")
    out({"ready": True, "device": device})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        t = time.time()
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            out({"error": f"bad request: {e}"})
            continue
        rid = req.get("id")
        try:
            text = mocr(req["image"])
            out({"id": rid, "text": text, "ms": int((time.time() - t) * 1000)})
        except Exception as e:
            out({"id": rid, "error": str(e), "ms": int((time.time() - t) * 1000)})


if __name__ == "__main__":
    main()
