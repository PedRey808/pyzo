"""Яндекс Музыка через неофициальную библиотеку yandex-music (нужен токен своего аккаунта)."""
import re
from pathlib import Path
from typing import List, Optional

from ..models import Track
from .base import Source, SourceError


# Страница входа Яндекса для официального клиента Яндекс Музыки (через него работает библиотека yandex-music).
# После входа Яндекс перенаправляет на music.yandex.ru/#access_token=<токен>&...
OAUTH_URL = "https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d"
_TOKEN_IN_URL = re.compile(r"access_token=([^&#\s]+)")


def extract_token(text: str) -> Optional[str]:
    """Токен из адреса после входа ('...#access_token=y0_..&...') или сам токен. None — если не похоже."""
    text = (text or "").strip()
    m = _TOKEN_IN_URL.search(text)
    if m:
        return m.group(1)
    if text and re.fullmatch(r"[A-Za-z0-9_\-.]{20,}", text):
        return text
    return None


class YandexSource(Source):
    name = "yandex"
    title = "Яндекс Музыка"

    def __init__(self, settings: dict):
        super().__init__(settings)
        self._client = None

    def available(self) -> bool:
        return bool(self.settings.get("yandex_token"))

    def client(self):
        if not self.available():
            raise SourceError("Яндекс Музыка: укажите токен в настройках")
        if self._client is None:
            from yandex_music import Client
            from yandex_music.utils.request import Request

            request = Request(proxy_url=self.settings["proxy"]) if self.settings.get("proxy") else None
            try:
                self._client = Client(self.settings["yandex_token"], request=request).init()
            except Exception as exc:  # неверный токен, нет сети
                raise SourceError(f"Яндекс Музыка: не удалось войти ({exc})") from exc
        return self._client

    def account_info(self) -> dict:
        """Кто вошёл и есть ли Плюс — чтобы сразу показать, что токен рабочий."""
        me = self.client().me
        acc = me.account if me else None
        login = (acc.login if acc else "") or ""
        name = ((acc.display_name or acc.full_name) if acc else "") or login
        return {"login": login, "name": name, "plus": bool(me and me.plus and me.plus.has_plus)}

    @staticmethod
    def _to_track(t) -> Track:
        album_id = t.albums[0].id if getattr(t, "albums", None) else None
        return Track(
            source="yandex",
            id=f"{t.id}:{album_id}" if album_id else str(t.id),
            title=t.title or "Без названия",
            artist=", ".join(t.artists_name()),
            duration=(t.duration_ms // 1000) if t.duration_ms else None,
            artwork=t.get_cover_url("400x400") if t.cover_uri else "",
            url=f"https://music.yandex.ru/album/{album_id}/track/{t.id}" if album_id else "",
            # трек скрыт в регионе / удалён правообладателем — звук найдём в других источниках
            protected=t.available is False,
            explicit=bool(t.explicit or t.content_warning == "explicit"),
        )

    def search(self, query: str, limit: int = 10) -> List[Track]:
        try:
            res = self.client().search(query, type_="track")
        except SourceError:
            raise
        except Exception as exc:
            raise SourceError(f"Яндекс Музыка: ошибка поиска ({exc})") from exc
        if not res or not res.tracks:
            return []
        return [self._to_track(t) for t in res.tracks.results[:limit]]

    def fetch_audio(self, track: Track, dest: Path) -> Path:
        client = self.client()
        try:
            t = client.tracks([track.id])[0]
            infos = [i for i in t.get_download_info() if i.codec == "mp3"]
            if not infos:
                raise SourceError("Яндекс Музыка: трек недоступен для вашего аккаунта")
            best = max(infos, key=lambda i: i.bitrate_in_kbps)
            out = dest.with_suffix(".mp3")
            best.download(str(out))
            return out
        except SourceError:
            raise
        except Exception as exc:
            raise SourceError(f"Яндекс Музыка: не удалось скачать ({exc})") from exc
