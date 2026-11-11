"""Подбор играбельного трека по метаданным (для Spotify и импорта плейлистов)."""
import re
from difflib import SequenceMatcher
from typing import Iterable, List, Optional

from .models import Track


def _norm(s: str) -> str:
    s = s.lower()
    s = re.sub(r"\((?:official|lyric|audio|video|hd|hq)[^)]*\)|\[[^\]]*\]", " ", s)
    s = re.sub(r"[^\w\s]", " ", s)
    return " ".join(s.split())


# «Цензурные» версии: запиканный мат, радио-версии и т.п.
_CENSORED = re.compile(
    r"\b(clean|censored|radio\s*edit|radio\s*version|edited|family\s*friendly)\b"
    r"|цензур|без\s+мата|радио\s*верси|радио\s*edit",
    re.IGNORECASE,
)


def looks_censored(track: Track) -> bool:
    return not track.explicit and bool(_CENSORED.search(track.title or ""))


def uncensored_first(tracks: List[Track]) -> List[Track]:
    """Версии без цензуры — выше, «цензурные» — в конец (порядок внутри групп сохраняется)."""
    return sorted(tracks, key=looks_censored)


def score(target: Track, candidate: Track, prefer_uncensored: bool = True) -> float:
    """0..1 — насколько candidate похож на target."""
    name_sim = SequenceMatcher(None, _norm(target.full_name), _norm(candidate.full_name)).ratio()
    title_sim = SequenceMatcher(None, _norm(target.title), _norm(candidate.title)).ratio()
    if _norm(target.title) and _norm(target.title) in _norm(candidate.full_name):
        title_sim = max(title_sim, 0.9)
    s = 0.5 * name_sim + 0.5 * title_sim
    if target.duration and candidate.duration:
        diff = abs(target.duration - candidate.duration)
        s *= 1.0 if diff <= 3 else 0.85 if diff <= 10 else 0.6 if diff <= 30 else 0.3
    if prefer_uncensored and not looks_censored(target):
        if looks_censored(candidate):
            s *= 0.75          # запиканная версия — только если другой нет
        elif candidate.explicit:
            s = min(1.0, s * 1.05)
    return s


def best_match(target: Track, candidates: Iterable[Track], threshold: float = 0.55,
               prefer_uncensored: bool = True) -> Optional[Track]:
    ranked = sorted(((score(target, c, prefer_uncensored), c) for c in candidates),
                    key=lambda x: x[0], reverse=True)
    if ranked and ranked[0][0] >= threshold:
        return ranked[0][1]
    return None
