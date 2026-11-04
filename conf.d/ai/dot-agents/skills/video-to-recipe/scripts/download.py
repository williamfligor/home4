#!/usr/bin/env -S uv run --script
#
# /// script
# requires-python = ">=3.10"
# dependencies = ["yt-dlp", "imageio-ffmpeg"]
# ///
"""Download a video (Instagram Reel, TikTok, YouTube Short, ...) with yt-dlp.

Usage:
    uv run scripts/download.py <URL> --outdir <dir>

Options:
    --outdir DIR        Directory to save outputs into (default: ./work)
    --cookies FILE      Path to a cookies.txt (or --cookies-from-browser BROWSER)
                        for sites that require login (e.g. private Instagram).
    --format FORMAT     yt-dlp format selector (default: best with merge fallback)

Writes:
    source.json         Metadata + paths to the downloaded media and subtitles.
    <title>.<ext>       The video file.
    *.srt               Subtitles, if the site provides them (requested as srt so
                        transcribe.py can parse them without extra deps).
"""

import argparse
import json
import os
import sys

import imageio_ffmpeg
import yt_dlp

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("url", help="Video URL (Instagram reel, TikTok, YouTube, ...)")
    ap.add_argument("--outdir", default="work")
    ap.add_argument("--cookies", help="cookies.txt path or browser name for yt-dlp")
    ap.add_argument("--format", default="bestvideo*+bestaudio/best")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)

    ydl_opts = {
        "outtmpl": os.path.join(args.outdir, "%(title).80s [%(id)s].%(ext)s"),
        "format": args.format,
        "ffmpeg_location": FFMPEG,
        "merge_output_format": "mp4",
        "writesubtitles": True,
        "writeautomaticsubtitles": True,
        "subtitleslangs": ["en", "en-orig", "en-us"],
        "subtitlesformat": "srt",
        "ignoreerrors": False,
        "quiet": True,
        "no_warnings": True,
    }
    if args.cookies:
        if os.path.exists(args.cookies):
            ydl_opts["cookiefile"] = args.cookies
        else:
            ydl_opts["cookiesfrombrowser"] = (args.cookies,)

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(args.url, download=True)
    except Exception as e:  # yt_dlp raises a grab bag of exceptions
        print(f"download failed: {e}", file=sys.stderr)
        return 1

    video_path = ydl.prepare_filename(info)
    if not os.path.exists(video_path):
        # format merging produces the merged file; find it in outdir just in case
        video_path = ""
        for f in sorted(os.listdir(args.outdir)):
            if f.endswith((".mp4", ".mkv", ".webm")):
                video_path = os.path.join(args.outdir, f)
                break

    subs = [
        f
        for f in sorted(os.listdir(args.outdir))
        if f.endswith(".srt") and f.startswith(ydl.prepare_filename(info).rsplit(os.sep, 1)[-1].split(".")[0])
    ]

    meta = {
        "url": info.get("webpage_url") or args.url,
        "title": info.get("title"),
        "uploader": info.get("uploader"),
        "duration": info.get("duration"),  # seconds
        "extractor": info.get("extractor"),
        "video_path": video_path,
        "subtitle_paths": subs,  # may be empty
    }
    with open(os.path.join(args.outdir, "source.json"), "w") as f:
        json.dump(meta, f, indent=2)

    print(json.dumps(meta, indent=2))
    if not video_path:
        print("WARNING: no video file produced", file=sys.stderr)
        return 1
    if not subs:
        print("NOTE: no subtitles available for this video; transcribe.py will use the audio API.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
