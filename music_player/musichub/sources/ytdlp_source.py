"""SoundCloud и YouTube через yt-dlp."""
from pathlib import Path
from typing import List

import yt_dlp

from .. import config, tsdemux
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
        ffmpeg = config.ffmpeg_path()
        extra = {
            "format": "bestaudio[ext=mp3]/bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best",
            "outtmpl": str(dest) + ".%(ext)s",
        }
        if ffmpeg:  # есть ffmpeg — приводим всё к mp3
            extra["ffmpeg_location"] = ffmpeg
            extra["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}]
        else:       # без ffmpeg (Android) — сохраняем как есть
            extra["fixup"] = "never"
        try:
            with yt_dlp.YoutubeDL(self._opts(**extra)) as ydl:
                ydl.extract_info(track.url, download=True)
        except yt_dlp.utils.DownloadError as exc:
            raise SourceError(f"{self.title}: не удалось скачать ({exc})") from exc
        found = sorted(p for p in dest.parent.glob(dest.name + ".*") if not p.name.endswith((".part", ".ytdl")))
        mp3 = dest.with_suffix(".mp3")
        result = mp3 if mp3.exists() else (found[0] if found else None)
        if result is None:
            raise SourceError("Файл не появился после загрузки")
        if not ffmpeg:
            result = tsdemux.fix_if_ts(result)
        return result


class SoundCloudSource(YtDlpSource):
    name = "soundcloud"
    title = "SoundCloud"
    search_prefix = "scsearch"

    def search(self, query: str, limit: int = 10) -> List[Track]:
        try:
            return self._api_search(query, limit)
        except SourceError:
            raise
        except Exception:  # изменилось внутреннее API yt-dlp — обычный поиск без отметок о DRM
            return super().search(query, limit)

    def _api_search(self, query: str, limit: int) -> List[Track]:
        """Поиск через API SoundCloud (как в yt-dlp), но с полной информацией о треке:
        так заранее видно, защищён ли трек DRM или доступен только 30-секундный отрывок."""
        with yt_dlp.YoutubeDL(self._opts()) as ydl:
            ie = ydl.get_info_extractor("SoundcloudSearch")
            try:
                ie.initialize()
                data = ie._call_api(
                    ie._API_V2_BASE + "search/tracks", query, "Поиск",
                    query={"q": query, "limit": limit, "offset": 0, "linked_partitioning": 1},
                    headers=ie._HEADERS)
            except yt_dlp.utils.ExtractorError as exc:
                raise SourceError(f"SoundCloud: ошибка поиска ({exc})") from exc
        return [self.item_to_track(i) for i in (data or {}).get("collection") or [] if i and i.get("id")]

    @staticmethod
    def item_to_track(item: dict) -> Track:
        transcodings = (item.get("media") or {}).get("transcodings") or []
        protocols = [((t.get("format") or {}).get("protocol") or "") for t in transcodings]
        drm_only = not protocols or all(p.startswith(("ctr-", "cbc-")) for p in protocols)
        preview_only = item.get("policy") == "SNIP"
        user = item.get("user") or {}
        art = (item.get("artwork_url") or user.get("avatar_url") or "").replace("-large.", "-t500x500.")
        ms = item.get("full_duration") or item.get("duration")
        return Track(
            source="soundcloud",
            id=str(item["id"]),
            title=item.get("title") or "Без названия",
            artist=user.get("username") or "",
            duration=int(ms) // 1000 if ms else None,
            artwork=art,
            url=item.get("permalink_url") or "",
            protected=drm_only or preview_only,
        )


class YouTubeSource(YtDlpSource):
    name = "youtube"
    title = "YouTube"
    search_prefix = "ytsearch"
