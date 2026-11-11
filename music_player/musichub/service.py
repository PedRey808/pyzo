"""Логика приложения: поиск по всем источникам, подбор аудио, кэш и скачивание."""
import re
import secrets
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional

from . import config
from .matcher import best_match, uncensored_first
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

    @property
    def uncensored(self) -> bool:
        return self.settings.get("uncensored", "1") == "1"

    def update_settings(self, values: dict) -> dict:
        config.save(values)
        self.reload()
        self.matches.clear()
        return config.public_view(self.settings)

    # ---------- Spotify: вход и медиатека ----------
    def spotify_login_url(self, port: int) -> str:
        from .sources.spotify import pkce_pair, redirect_uri

        verifier, challenge = pkce_pair()
        state = secrets.token_urlsafe(16)
        now = time.time()
        self._spotify_states = {k: v for k, v in getattr(self, "_spotify_states", {}).items() if now - v[1] < 900}
        self._spotify_states[state] = (verifier, now, redirect_uri(port))
        return self.sources["spotify"].authorize_url(redirect_uri(port), state, challenge)

    def spotify_finish(self, code: str, state: str) -> str:
        pending = getattr(self, "_spotify_states", {}).pop(state, None)
        if not pending:
            raise SourceError("Spotify: вход устарел, нажмите «Войти через Spotify» ещё раз")
        verifier, _, redirect = pending
        result = self.sources["spotify"].exchange_code(code, redirect, verifier)
        config.save({"spotify_refresh_token": result["refresh_token"], "spotify_user": result["user"]})
        self.reload()
        return result["user"]

    def spotify_logout(self):
        config.save({"spotify_refresh_token": "", "spotify_user": ""})
        self.reload()

    def spotify_status(self) -> dict:
        sp = self.sources["spotify"]
        if not sp.logged_in():
            return {"logged_in": False, "client_id": bool(self.settings.get("spotify_client_id"))}
        me = sp.me()
        return {"logged_in": True, "client_id": True, "name": me["name"], "product": me["product"]}

    def spotify_liked(self) -> dict:
        return {"results": {"spotify": self._remember(self.sources["spotify"].liked())}, "errors": {}}

    def spotify_playlists(self) -> List[dict]:
        return self.sources["spotify"].playlists()

    def spotify_playlist(self, playlist_id: str) -> dict:
        return {"results": {"spotify": self._remember(self.sources["spotify"].playlist_tracks(playlist_id))},
                "errors": {}}

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
                    if self.uncensored:
                        tracks = uncensored_first(tracks)
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
        if track.key in self.matches:
            return self.matches[track.key]
        if track.source != "spotify" and not track.protected:
            return track
        return self.find_elsewhere(track)

    def find_elsewhere(self, track: Track) -> Track:
        """Тот же трек в другом источнике: для Spotify и для треков, которые источник не отдаёт (DRM)."""
        tried = []
        for name in self.MATCH_ORDER:
            src = self.sources[name]
            if not src.available():
                continue
            try:
                candidates = [c for c in src.search(track.full_name, 6) if not c.protected and c.key != track.key]
            except SourceError as exc:
                tried.append(str(exc))
                continue
            match = best_match(track, candidates, prefer_uncensored=self.uncensored)
            if match:
                self.registry[match.key] = match
                self.matches[track.key] = match
                return match
        detail = ("; ".join(tried)) if tried else "в других источниках не нашлось"
        raise SourceError(f"Не нашёл звук для «{track.full_name}»: {detail}")

    def resolved_via(self, key: str):
        """Если звук взят из другого источника — этот трек, иначе None."""
        return self.matches.get(key)

    def _lock(self, key: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(key, threading.Lock())

    def cached_audio(self, key: str) -> Path:
        """Путь к аудиофайлу в кэше (скачивает при первом обращении)."""
        track = self.registry.get(key)
        if track is None:
            raise KeyError(key)
        real = self.playable(track)
        try:
            path = self._fetch_cached(real)
        except SourceError as exc:
            if real is not track:
                raise
            # источник отказал (DRM, недоступно в регионе и т.п.) — ищем этот трек в других
            track.protected = True
            try:
                alt = self.find_elsewhere(track)
            except SourceError as not_found:
                raise SourceError(f"{exc}. {not_found}") from exc
            path = self._fetch_cached(alt)
        self._trim_cache()
        return path

    def _fetch_cached(self, real: Track) -> Path:
        config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
        stem = safe_filename(real.key.replace(":", "_"))
        with self._lock(real.key):
            existing = [p for p in config.CACHE_DIR.glob(stem + ".*") if p.suffix in AUDIO_EXT]
            if existing:
                existing[0].touch()
                return existing[0]
            return self.sources[real.source].fetch_audio(real, config.CACHE_DIR / stem)

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
