#!/usr/bin/env -S uv run --script
#
# /// script
# requires-python = ">=3.10"
# dependencies = ["openai", "imageio-ffmpeg"]
# ///
"""Extract all on-screen text from a video using a vision model (gpt-5.6-luna).

Recipe reels/tutorials almost always flash ingredient lists and step headers
on screen, often faster than they can be narrated (and sometimes with no
narration at all). This samples keyframes throughout the video and asks a
vision model to read every piece of text verbatim, with timestamps.

Usage:
    uv run scripts/ocr-extraction.py \
        --video <path> --outdir <dir>

Options:
    --video PATH        Path to the downloaded video file.
    --outdir DIR        Where to write frames/ (keyframes) and
                        onscreen_text.json.
    --interval SEC      Seconds between sampled frames (default 3).
    --max-frames N      Cap on total frames (default 40).
    --model ID          Vision model (default gpt-5.6-luna).
    --skip-frames       Don't re-extract frames if frames/ already exists.

Writes:
    frames/frame_<t>.jpg   Keyframes, timestamp t in the filename.
    onscreen_text.json     [{"time": t, "text": "..."}] in chronological order,
                           deduped (consecutive identical text collapsed).
"""

import argparse
import base64
import json
import os
import subprocess
import sys

import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

SYSTEM = (
    "You are a precise OCR engine for cooking videos. The user sends you video "
    "keyframes sampled every few seconds. Extract ALL readable on-screen text "
    "verbatim: ingredient lists, step headings, measurements, titles. Preserve "
    "numbers, units, abbreviations, and line structure (join lines that belong "
    "to one item with a space). Report which frame each piece of text appears "
    "in. Ignore channel watermarks, app UI (hearts, views, captions button), "
    "and text stickers that are not recipe content. If a frame has no usable "
    "text, omit it. Return strict JSON matching the provided schema."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "frame_index": {"type": "integer"},
                    "text": {"type": "string"},
                },
                "required": ["frame_index", "text"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


def extract_frames(
    video: str, frames_dir: str, interval: float, max_frames: int, duration_hint: float | None
) -> list[tuple[float, str]]:
    os.makedirs(frames_dir, exist_ok=True)
    # Probe duration if we don't have a hint.
    if duration_hint is None:
        probe = subprocess.run([FFMPEG, "-i", video], capture_output=True, text=True)
        import re

        m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", probe.stderr)
        duration_hint = (int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])) if m else 60.0
    count = int(duration_hint // interval)
    if max_frames:
        count = min(count, max_frames)
    times = [round(i * interval, 2) for i in range(count)]
    out = []
    for i, t in enumerate(times):
        path = os.path.join(frames_dir, f"frame_{t:04.1f}.jpg")
        if not os.path.exists(path):
            subprocess.run(
                [
                    FFMPEG,
                    "-y",
                    "-ss",
                    str(t),
                    "-i",
                    video,
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=-2:540",
                    "-q:v",
                    "3",
                    path,
                ],
                check=True,
                capture_output=True,
            )
        out.append((t, path))
    return out


def ocr_batch(frames: list[tuple[float, str]], model: str) -> list[dict]:
    from openai import OpenAI

    client = OpenAI()
    content = []
    for i, (t, path) in enumerate(frames):
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        content.append(
            {
                "type": "input_image",
                "image_url": f"data:image/jpeg;base64,{b64}",
                "detail": "high",
            }
        )
        content.append(
            {
                "type": "input_text",
                "text": f"Frame {i} was captured at about {t:.1f}s into the video.",
            }
        )
    content.append(
        {
            "type": "input_text",
            "text": "Extract the on-screen text in these frames now. Return only the JSON schema result.",
        }
    )
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": content}]
    try:
        resp = client.responses.create(
            model=model,
            input=messages,
            text={
                "format": {"type": "json_schema", "name": "onscreen_text", "strict": True, "schema": SCHEMA}
            },
        )
    except Exception:
        # Fallback: ask for plain JSON in text and parse it.
        resp = client.responses.create(model=model, input=messages)
    out = (getattr(resp, "output_text", "") or "").strip()
    try:
        data = json.loads(out)
    except Exception:
        # sometimes wrapped in fences or prose
        start, end = out.find("{"), out.rfind("}")
        if start == -1 or end == -1:
            return []
        data = json.loads(out[start : end + 1])
    return data.get("items", [])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--video", required=True)
    ap.add_argument("--outdir", default="work")
    ap.add_argument("--interval", type=float, default=3.0)
    ap.add_argument("--max-frames", type=int, default=40)
    ap.add_argument("--model", default="gpt-5.6-luna")
    ap.add_argument("--skip-frames", action="store_true")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    frames_dir = os.path.join(args.outdir, "frames")
    if args.skip_frames and os.path.isdir(frames_dir):
        import glob

        frames = []
        for p in sorted(glob.glob(os.path.join(frames_dir, "frame_*.jpg"))):
            t = float(os.path.basename(p)[6:-4])
            frames.append((t, p))
    else:
        frames = extract_frames(args.video, frames_dir, args.interval, args.max_frames, None)

    if not frames:
        print("ERROR: no frames extracted", file=sys.stderr)
        return 1

    # Batch ~6 frames per API call so each image stays legible to the model.
    items: list[dict] = []
    for i in range(0, len(frames), 6):
        items.extend(ocr_batch(frames[i : i + 6], args.model))
        print(f"processed frames {i}-{min(i + 5, len(frames) - 1)}", file=sys.stderr)

    frame_times = {i: t for i, (t, _) in enumerate(frames)}
    seen = set()
    result = []
    for it in sorted(items, key=lambda x: x.get("frame_index", 0)):
        fi = it.get("frame_index")
        text = (it.get("text") or "").strip()
        if fi is None or not text:
            continue
        t = round(frame_times.get(fi, 0), 2)
        # collapse consecutive duplicate text (same card shown across frames)
        if result and result[-1]["text"] == text and abs(result[-1]["time"] - t) <= args.interval + 0.5:
            continue
        if (t, text) in seen:
            continue
        seen.add((t, text))
        result.append({"time": t, "text": text})

    with open(os.path.join(args.outdir, "onscreen_text.json"), "w") as f:
        json.dump(result, f, indent=2)

    print(json.dumps({"frame_count": len(frames), "text_items": len(result)}, indent=2))
    if not result:
        print("NOTE: no on-screen text found — video may rely on narration only.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
