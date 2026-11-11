"""Логика приложения: поиск по всем источникам, подбор аудио, кэш и скачивание."""
import re
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional

from . import config
from .matcher import best_match
from .models import Track
from .sources.base import Source, SourceError
from .sources.spotify import SpotifySource, parse_spotify_url
from .sources.yandex import YandexSource
from .sources.ytdlp_source import SoundCloudSource, YouTubeSource

CACHE_LIMIT_BYTES = 1024 ** 3  # 1 ГБ кэша прослушивания
AUDIO_EXT = (".mp3", ".m4a", ".aac", ".opus", ".ogg", ".flac", ".wav", ".webm")


def safe_filename(name: str, max_len: int = 150) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(" .")
    return (name or "track")[:max_len]


class MusicHub:
    # порядок источников, в которых ищем звук для треков Spotify
    MATCH_ORDER = ("yandex", "soundcloud", "youtube")

    def __init__(self):
        self._locks: Dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self.registry: Dict[str, Track] = {}
        self.matches: Dict[str, Track] = {}
        self.reload()

    # ---------- настройки ----------
    def reload(self):
        self.settings = config.load()
        self.sources: Dict[str, Source] = {
            s.name: s for s in (
                YandexSource(self.settings),
                SoundCloudSource(self.settings),
                SpotifySource(self.settings),
                YouTubeSource(self.settings),
            )
        }

    def update_settings(self, values: dict) -> dict:
        config.save(values)
        self.reload()
        self.matches.clear()
        return config.public_view(self.settings)

    def yandex_account(self) -> dict:
        return self.sources["yandex"].account_info()

    def sources_info(self) -> List[dict]:
        return [{"name": s.name, "title": s.title, "available": s.available()} for s in self.sources.values()]

    # ---------- поиск ----------
    def _remember(self, tracks: List[Track]) -> List[dict]:
        for t in tracks:
            self.registry[t.key] = t
        return [t.to_dict() for t in tracks]

    def search(self, query: str, source: str = "all", limit: int = 10) -> dict:
        query = query.strip()
        if not query:
            return {"results": {}, "errors": {}}
        if parse_spotify_url(query):
            return self.import_url(query)
        if source == "all":
            names = [n for n, s in self.sources.items() if s.available()]
        elif source in self.sources:
            names = [source]
        else:
            raise SourceError(f"Неизвестный источник: {source}")

        results, errors = {}, {}

        def run(name):
            return name, self.sources[name].search(query, limit)

        with ThreadPoolExecutor(max_workers=len(names) or 1) as pool:
            futures = [pool.submit(run, n) for n in names]
            for n, f in zip(names, futures):
                try:
                    _, tracks = f.result(timeout=40)
                    results[n] = self._remember(tracks)
                except Exception as exc:  # один источник упал — остальные работают
                    errors[n] = str(exc)
        return {"results": results, "errors": errors}

    def import_url(self, url: str) -> dict:
        tracks = self.sources["spotify"].import_url(url)
        return {"results": {"spotify": self._remember(tracks)}, "errors": {}}

    def register(self, track_data: dict) -> Track:
        track = Track.from_dict(track_data)
        if track.source not in self.sources:
            raise SourceError("Неизвестный источник трека")
        self.registry[track.key] = track
        return track

    # ---------- подбор звука ----------
    def playable(self, track: Track) -> Track:
        """Трек, из которого реально можно взять звук."""
        if track.source != "spotify":
            return track
        if track.key in self.matches:
            return self.matches[track.key]
        tried = []
        for name in self.MATCH_ORDER:
            src = self.sources[name]
            if not src.available():
                continue
            try:
                candidates = src.search(track.full_name, 5)
            except SourceError as exc:
                tried.append(str(exc))
                continue
            match = best_match(track, candidates)
            if match:
                self.registry[match.key] = match
                self.matches[track.key] = match
                return match
        detail = ("; ".join(tried)) if tried else "совпадений не найдено"
        raise SourceError(f"Не нашёл звук для «{track.full_name}»: {detail}")

    def _lock(self, key: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(key, threading.Lock())

    def cached_audio(self, key: str) -> Path:
        """Путь к аудиофайлу в кэше (скачивает при первом обращении)."""
        track = self.registry.get(key)
        if track is None:
            raise KeyError(key)
        real = self.playable(track)
        config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
        stem = safe_filename(real.key.replace(":", "_"))
        with self._lock(real.key):
            existing = [p for p in config.CACHE_DIR.glob(stem + ".*") if p.suffix in AUDIO_EXT]
            if existing:
                existing[0].touch()
                return existing[0]
            path = self.sources[real.source].fetch_audio(real, config.CACHE_DIR / stem)
        self._trim_cache()
        return path

    def _trim_cache(self):
        files = sorted(config.CACHE_DIR.glob("*"), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        while files and total > CACHE_LIMIT_BYTES:
            p = files.pop(0)
            total -= p.stat().st_size
            p.unlink(missing_ok=True)

    # ---------- скачивание ----------
    def download_dir(self) -> Path:
        d = Path(self.settings["download_dir"]).expanduser()
        d.mkdir(parents=True, exist_ok=True)
        return d

    def download(self, key: str) -> Path:
        track = self.registry.get(key)
        if track is None:
            raise KeyError(key)
        src = self.cached_audio(key)
        target = self.download_dir() / (safe_filename(track.full_name) + src.suffix)
        if not target.exists():
            shutil.copyfile(src, target)
            write_tags(target, track)
        return target

    def library(self) -> List[dict]:
        d = self.download_dir()
        files = sorted((p for p in d.iterdir() if p.suffix.lower() in AUDIO_EXT),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        out = []
        for p in files:
            artist, _, title = p.stem.partition(" - ")
            out.append({"name": p.name, "title": title or artist, "artist": artist if title else "",
                        "size": p.stat().st_size})
        return out

    def library_file(self, name: str) -> Optional[Path]:
        d = self.download_dir().resolve()
        p = (d / name).resolve()
        if p.parent != d or not p.is_file():
            return None
        return p


def write_tags(path: Path, track: Track):
    """Записать название/исполнителя в файл (ошибки тегов не критичны)."""
    try:
        import mutagen

        f = mutagen.File(str(path), easy=True)
        if f is None:
            return
        if f.tags is None:
            f.add_tags()
        f["title"] = track.title
        if track.artist:
            f["artist"] = track.artist
        f.save()
    except Exception:
        pass
