from __future__ import annotations

import os
import time
from typing import Any, Callable, Dict, Optional

from google import genai
from google.genai import types
from pydantic import BaseModel, Field


class TranslatedCaptionResponse(BaseModel):
    translated_transcript: str = Field(min_length=1)
    translated_hook_title: str = Field(default="")


def _default_translate_caller(prompt: str) -> TranslatedCaptionResponse:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY environment variable is required for caption translation.")

    model_name = os.environ.get("GEMINI_MODEL", "gemini-4-hydrogen").strip() or "gemini-4-hydrogen"
    client = genai.Client(
        api_key=api_key,
        http_options={"headers": {"User-Agent": "aistudio-build"}},
    )

    last_exc: Optional[Exception] = None
    for attempt in range(4):
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=TranslatedCaptionResponse,
                ),
            )
            if not response.text:
                raise RuntimeError("Gemini returned an empty translation response.")
            return TranslatedCaptionResponse.model_validate_json(response.text)
        except Exception as exc:
            last_exc = exc
            err_text = str(exc)
            if any(
                tok in err_text
                for tok in ("API_KEY_INVALID", "API key not valid", "UNAUTHENTICATED", "PERMISSION_DENIED", "NOT_FOUND")
            ):
                raise RuntimeError(f"Gemini translation error ({model_name}): {err_text}") from exc
            if attempt < 3:
                time.sleep(min(12.0, 1.5 * (2**attempt)))

    raise RuntimeError(f"Caption translation failed after retries: {last_exc}") from last_exc


def translate_caption_text(
    transcript_text: str,
    target_language: str,
    hook_title: str = "",
    llm_caller: Optional[Callable[[str], TranslatedCaptionResponse]] = None,
) -> Dict[str, str]:
    """
    Translate a clip's spoken transcript and optional hook title into `target_language`
    using Gemini structured JSON output. Preserves natural short-form phrasing and rhythm.
    """
    clean_text = (transcript_text or "").strip()
    if not clean_text:
        raise ValueError("Clip has no transcript text to translate.")
    lang = (target_language or "").strip()
    if not lang:
        raise ValueError("Target language is required.")

    script_hint = (
        "Use natural Devanagari script for Hindi."
        if lang.lower() == "hindi"
        else "Use conversational Romanized Hindi-English (Hinglish)."
        if lang.lower() == "hinglish"
        else f"Use natural, native phrasing in {lang}."
    )

    prompt = (
        f"Translate the following short-form video captions into {lang}.\n"
        f"{script_hint}\n"
        "Keep timing-friendly brevity and natural spoken cadence so captions stay readable on screen.\n"
        "Preserve meaning faithfully without adding commentary or disclaimers.\n\n"
        f"Hook title (translate concisely, max 8 words): {hook_title or '(none)'}\n"
        f"Transcript:\n{clean_text}"
    )

    caller = llm_caller or _default_translate_caller
    result = caller(prompt)
    return {
        "translated_transcript": result.translated_transcript.strip(),
        "translated_hook_title": (result.translated_hook_title or hook_title or "").strip(),
        "target_language": lang,
    }
