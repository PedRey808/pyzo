"""Spotify: только метаданные (поиск, плейлисты) через официальный Web API.

Аудио Spotify защищено DRM, поэтому звук для каждого трека подбирается
в других источниках (Яндекс Музыка → SoundCloud → YouTube) по названию и длительности.
"""
import base64
import re
import time
from typing import List, Optional

import httpx

from ..models import Track
from .base import Source, SourceError

API = "https://api.spotify.com/v1"
TOKEN_URL = "https://accounts.spotify.com/api/token"


def parse_spotify_url(url: str) -> Optional[tuple]:
    """'https://open.spotify.com/playlist/ID?si=..' или 'spotify:track:ID' -> ('playlist', 'ID')."""
    m = re.search(r"(?:open\.spotify\.com/(?:intl-[a-z]+/)?|spotify:)(track|album|playlist)[/:]([A-Za-z0-9]+)", url)
    return (m.group(1), m.group(2)) if m else None


class SpotifySource(Source):
    name = "spotify"
    title = "Spotify"

    def __init__(self, settings: dict):
        super().__init__(settings)
        self._token = None
        self._token_exp = 0.0

    def available(self) -> bool:
        return bool(self.settings.get("spotify_client_id") and self.settings.get("spotify_client_secret"))

    def _http(self) -> httpx.Client:
        return httpx.Client(timeout=15, proxy=self.settings.get("proxy") or None)

    def _auth(self) -> str:
        if not self.available():
            raise SourceError("Spotify: укажите Client ID и Client Secret в настройках")
        if self._token and time.time() < self._token_exp - 30:
            return self._token
        creds = f"{self.settings['spotify_client_id']}:{self.settings['spotify_client_secret']}"
        with self._http() as c:
            r = c.post(TOKEN_URL, data={"grant_type": "client_credentials"},
                       headers={"Authorization": "Basic " + base64.b64encode(creds.encode()).decode()})
        if r.status_code != 200:
            raise SourceError(f"Spotify: не удалось авторизоваться ({r.status_code})")
        data = r.json()
        self._token, self._token_exp = data["access_token"], time.time() + data.get("expires_in", 3600)
        return self._token

    def _get(self, path: str, **params) -> dict:
        url = path if path.startswith("http") else API + path
        with self._http() as c:
            r = c.get(url, params=params or None, headers={"Authorization": f"Bearer {self._auth()}"})
        if r.status_code != 200:
            raise SourceError(f"Spotify: ошибка API {r.status_code}")
        return r.json()

    @staticmethod
    def _to_track(t: dict, album: Optional[dict] = None) -> Track:
        album = album or t.get("album") or {}
        images = album.get("images") or []
        return Track(
            source="spotify",
            id=t["id"],
            title=t.get("name", ""),
            artist=", ".join(a["name"] for a in t.get("artists", [])),
            duration=(t["duration_ms"] // 1000) if t.get("duration_ms") else None,
            artwork=images[0]["url"] if images else "",
            url=(t.get("external_urls") or {}).get("spotify", ""),
        )

    def search(self, query: str, limit: int = 10) -> List[Track]:
        data = self._get("/search", q=query, type="track", limit=min(limit, 10))
        return [self._to_track(t) for t in data.get("tracks", {}).get("items", []) if t]

    def import_url(self, url: str) -> List[Track]:
        parsed = parse_spotify_url(url)
        if not parsed:
            raise SourceError("Это не ссылка Spotify на трек, альбом или плейлист")
        kind, sid = parsed
        if kind == "track":
            return [self._to_track(self._get(f"/tracks/{sid}"))]
        if kind == "album":
            album = self._get(f"/albums/{sid}")
            items, page = [], album.get("tracks")
            while page:
                items += [self._to_track(t, album) for t in page.get("items", []) if t]
                page = self._get(page["next"]) if page.get("next") else None
            return items
        items, page = [], self._get(f"/playlists/{sid}/tracks", limit=100)
        while page:
            for it in page.get("items", []):
                t = it.get("track") or it.get("item")
                if t and t.get("id") and t.get("type", "track") == "track":
                    items.append(self._to_track(t))
            page = self._get(page["next"]) if page.get("next") else None
        return items
