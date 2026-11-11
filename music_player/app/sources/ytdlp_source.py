"""SoundCloud и YouTube через yt-dlp."""
from pathlib import Path
from typing import List

import yt_dlp

from ..models import Track
from .base import Source, SourceError


def _best_thumb(entry: dict) -> str:
    if entry.get("thumbnail"):
        return entry["thumbnail"]
    thumbs = entry.get("thumbnails") or []
    return thumbs[-1].get("url", "") if thumbs else ""


class YtDlpSource(Source):
    search_prefix = ""

    def _opts(self, **extra) -> dict:
        opts = {"quiet": True, "no_warnings": True, "noplaylist": True}
        if self.settings.get("proxy"):
            opts["proxy"] = self.settings["proxy"]
        opts.update(extra)
        return opts

    def _entry_to_track(self, e: dict) -> Track:
        return Track(
            source=self.name,
            id=str(e.get("id")),
            title=e.get("title") or "Без названия",
            artist=e.get("uploader") or e.get("channel") or e.get("artist") or "",
            duration=int(e["duration"]) if e.get("duration") else None,
            artwork=_best_thumb(e),
            url=e.get("webpage_url") or e.get("url") or "",
        )

    def search(self, query: str, limit: int = 10) -> List[Track]:
        q = f"{self.search_prefix}{limit}:{query}"
        try:
            with yt_dlp.YoutubeDL(self._opts(extract_flat=True)) as ydl:
                info = ydl.extract_info(q, download=False)
        except yt_dlp.utils.DownloadError as exc:
            raise SourceError(f"{self.title}: {exc}") from exc
        tracks = []
        for e in (info or {}).get("entries") or []:
            if not e or e.get("_has_drm") or e.get("has_drm"):
                continue
            tracks.append(self._entry_to_track(e))
        return tracks

    def fetch_audio(self, track: Track, dest: Path) -> Path:
        if not track.url:
            raise SourceError("У трека нет ссылки для загрузки")
        opts = self._opts(
            format="bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
            outtmpl=str(dest) + ".%(ext)s",
            postprocessors=[{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}],
        )
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.extract_info(track.url, download=True)
        except yt_dlp.utils.DownloadError as exc:
            raise SourceError(f"{self.title}: не удалось скачать ({exc})") from exc
        result = dest.with_suffix(".mp3")
        if not result.exists():
            found = sorted(dest.parent.glob(dest.name + ".*"))
            if not found:
                raise SourceError("Файл не появился после загрузки (установлен ли ffmpeg?)")
            result = found[0]
        return result


class SoundCloudSource(YtDlpSource):
    name = "soundcloud"
    title = "SoundCloud"
    search_prefix = "scsearch"


class YouTubeSource(YtDlpSource):
    name = "youtube"
    title = "YouTube"
    search_prefix = "ytsearch"
