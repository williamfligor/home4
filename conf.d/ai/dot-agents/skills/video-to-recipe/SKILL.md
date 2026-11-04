---
name: video-to-recipe
description: >-
    Turn any cooking or food video into a complete written recipe. Downloads the
    video (Instagram Reels, TikTok, YouTube Shorts, or any yt-dlp-supported URL),
    transcribes the narration with OpenAI gpt-transcribe, reads on-screen text
    off keyframes with the gpt-5.6-luna vision model, and assembles a full
    markdown recipe with a complete ingredients list and step-by-step
    instructions. Use this whenever the user pastes a video URL and wants a
    recipe, says things like "turn this reel into a recipe", "what's the recipe
    for this?", "extract the recipe from this video", "I saw a cooking video,
    can you write it down for me", or wants the ingredients/steps saved from any
    food video — even if they never say "download", "transcribe", or "recipe".
    Trigger for any cooking/food video → written recipe request, whether the
    video is French, Spanish, or spoken over music.
---

# Video → Recipe

Turning a video into a recipe has two halves, and you should respect the split:

1. **Deterministic extraction** — the bundled scripts do this: download,
   transcribe, grab on-screen text. Do not improvise around them; run them
   and read their outputs.
2. **Judgment** — you do this: combine the transcript, the on-screen text,
   and (when they help) the keyframes into a recipe that a cook could
   actually follow.

Recipe videos are often misleading as raw material: narration is squeezed
over music, quantities are flashed on screen for a second, and some reels
have _no narration at all_ — just text cards. That's why the pipeline gathers
three independent signals. A recipe written from only one of them will be
wrong or incomplete half the time.

## Prerequisites

- `uv` installed (`uvx` works — the scripts run through `uv run`).
- `OPENAI_API_KEY` set in the environment (needed by transcribe/ocr steps).
- Network access for downloads and API calls.

## Quick start

```bash
SKILL=<path-to-this-skill-directory>   # e.g. ~/.agents/skills/video-to-recipe
WORK=$(mktemp -d -t vid2recipe.XXXXXX) # all intermediate artifacts live here

uv run "$SKILL/scripts/download.py" "<URL>" --outdir "$WORK"
uv run "$SKILL/scripts/transcribe.py" --video "$WORK"/*.mp4 --source "$WORK/source.json" --outdir "$WORK"
uv run "$SKILL/scripts/ocr-extraction.py" --video "$WORK"/*.mp4 --outdir "$WORK"
```

Each script declares its own dependencies (PEP 723 inline metadata), so the
first `uv run` per script sets up a cached environment automatically — no
pyproject.toml or manual installs.

Everything except the final recipe is temporary. Keep the artifacts around
only for the duration of assembly, then clean up:

```bash
# after the recipe is written and you no longer need the keyframes:
rm -rf "$WORK"
```

## What the scripts produce

| Step                | Input              | Output                                      | Notes                                                         |
| ------------------- | ------------------ | ------------------------------------------- | ------------------------------------------------------------- |
| `download.py`       | URL                | `source.json`, video file, optional `*.srt` | May fail on private content — see Troubleshooting             |
| `transcribe.py`     | video, source.json | `transcript.json`, `transcript.txt`         | Uses subtitles if present, else `gpt-transcribe` on the audio |
| `ocr-extraction.py` | video              | `onscreen_text.json`, `frames/*.jpg`        | Keyframes every ~3s read by gpt-5.6-luna                      |

- `transcript.json` → `{"used": "subtitles"|"gpt-transcribe", "segments": [{"start", "end", "text"}]}`
- `onscreen_text.json` → `[{"time": 5.0, "text": "INGREDIENTS: 2 cups flour..."}]` chronologically.
- `frames/` — the actual keyframes. Look at them directly when text is ambiguous
  or the transcript and OCR disagree; your own eyes resolve what the pipeline can't.

## Assembling the recipe

1. Read all three outputs plus `source.json` (title, uploader, duration).
2. Cross-check the transcript against `onscreen_text.json`. The transcript is
   the narrative; the on-screen text is the truth for _numbers_.
    - When they disagree on an ingredient or quantity, **trust the on-screen
      text** and note the correction in the recipe notes. Example: transcript
      says "two cops flour" and OCR shows "2 cups flour" → 2 cups flour;
      they aren't a conflict to report, they're one source correcting another.
    - If something appears in the transcript but in no on-screen text, keep it —
      narration-only details (technique, timing, doneness cues) are often legit.
3. If the transcript is empty, music-lyrics-only, or clearly garbled (reel with
   no narration), rely on `onscreen_text.json` and the frames alone. Say so in
   the recipe notes ("transcribed narration was unavailable").

4. **Burned-in captions:** many reels have Instagram's auto-captions baked into
   the video, so `onscreen_text.json` will contain caption lines that merely
   repeat the narration. When on-screen text duplicates the transcript, treat
   it as _confirmation_, not a new signal — don't elevate it into the recipe
   twice. The valuable on-screen text is what _isn't_ spoken: ingredient lists,
   quantities, price/per-meal badges, step headers.

    Also watch for rendering artifacts: a busy animated overlay may OCR as
    overprecise (e.g. `$2.16666667 per meal` from a counter animation). Round
    figures that are clearly display artifacts; never invent precision.

5. Look at 3–5 keyframes yourself (especially the ingredient-list ones) when:
    - the OCR text seems truncated, or a step references something unseen (e.g.
      "then fold" — fold _what_?),
    - quantities look off, or
    - the video shows a technique worth describing in words.
6. **Never invent ingredients or steps.** Everything in the recipe must trace
   back to the transcript, on-screen text, or something you can see in a
   keyframe. If a step is genuinely ambiguous ("cook until done"), keep the
   original wording and add a bracketed clarification — a guess masquerading
   as precision is worse than an honest hedge. If a quantity is vague in the
   source ("a tub of cornstarch", "a splash"), say so in Notes rather than
   inventing a number.

    **Don't put words in the creator's mouth.** Only quote the narration when
    you can point at the exact transcript line — never construct a "quote" or
    a "the video says X" from memory of the gist. If you're paraphrasing an
    aside (e.g. "I didn't have enough cream cheese, so I grated the rest of my
    cheddar"), make sure the paraphrase says what the creator actually did,
    not advice you wish they'd given.

7. **Not-a-recipe guard:** if the video turns out not to be a cooking/food
   recipe at all (a mukbang, a kitchen tour, an ad), don't force a recipe out
   of it. Say plainly: _"This video does not appear to contain a recipe."_
   then one sentence on what it actually is, so the user can decide.

## Recipe format

Always write the recipe in Markdown using this template. Show it in the chat
(in a code block so it's copy-pasteable), and offer to save a copy somewhere
durable (e.g. `./recipe.md` in the user's current directory, or ask them where)
— never inside `$WORK`, which gets deleted:

```markdown
# <Recipe Title>

> Source: <url> · by <uploader>

**Prep time:** [e.g. 15 min] · **Cook time:** [e.g. 30 min] · **Servings:** [e.g. 4]

## Ingredients

- <item, with exact quantities — prefer on-screen text quantities when the
  narration is vague>

## Instructions

1. <numbered steps, in order, incorporating techniques from the narration>
    - sub-steps or notes as needed

## Notes / Tips

- <ambiguities resolved, substitutions the video suggested, or "transcribed
  narration was unavailable; recipe from on-screen text">
```

- Use the video's own name or a descriptive title from it, not a made-up one.
- **Ingredients first with exact quantities**, even when the video only shows
  them on screen for a second.
- Include everything relevant from the narration that text wouldn't capture:
  heat levels, resting times, doneness cues ("foamy", "browns in 30s"), order
  of operations.
- End with the source URL so the user can rewatch the original.
- If the language isn't English, translate the recipe into English and keep the
  original terms in parentheses for specialty ingredients (e.g. `gochujang (고추장)`).

## Troubleshooting

- **"Sign in to confirm you're not a bot" / private reel:** re-run
  `download.py` with `--cookies-from-browser` (e.g.
  `--cookies-from-browser firefox`) or pass `--cookies cookies.txt`.
- **Downloaded but `transcribe.py` used weird subtitles:** subtitles can be
  auto-generated lyrics or mistranslated garbage. Re-run with `--force-api`
  to transcribe the actual audio.
- **`ocr-extraction.py` found no text:** the video genuinely may have none —
  proceed on transcript alone.
- **gpt-transcribe file too large:** rare with reels; the API accepts files up
  to 25MB. For video way over that, tell the user and offer to transcribe a
  trimmed segment.
- **API key missing:** both API scripts fail fast and explain — the skill
  cannot transcribe/OCR without `OPENAI_API_KEY`.

## Notes on cost/behavior

- API calls are metered per token (`gpt-transcribe` ~$0.006/min audio,
  gpt-5.6-luna vision ~$0.01 per 20 frames) — trivial per video, intended.
- Scripts are idempotent-ish: re-running an existing step reuses downloaded
  files where possible (frames are skipped if present).
