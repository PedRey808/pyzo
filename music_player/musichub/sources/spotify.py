"""Spotify: только метаданные (поиск, плейлисты, «Любимые») через официальный Web API.

Аудио Spotify защищено DRM, поэтому звук для каждого трека подбирается
в других источниках (Яндекс Музыка → SoundCloud → YouTube) по названию и длительности.

Два способа доступа:
* «Войти через Spotify» (OAuth с PKCE) — нужен только Client ID своего приложения
  на developer.spotify.com; даёт поиск, свои плейлисты и «Любимые треки»;
* Client ID + Client Secret — только поиск и публичные плейлисты.
"""
import base64
import hashlib
import re
import secrets
import time
from typing import List, Optional
from urllib.parse import urlencode

import httpx

from ..models import Track
from .base import Source, SourceError

API = "https://api.spotify.com/v1"
TOKEN_URL = "https://accounts.spotify.com/api/token"
AUTHORIZE_URL = "https://accounts.spotify.com/authorize"
SCOPES = "user-library-read playlist-read-private playlist-read-collaborative"


def redirect_uri(port: int) -> str:
    # Spotify разрешает http только для 127.0.0.1; этот адрес нужно добавить в настройки приложения Spotify
    return f"http://127.0.0.1:{port}/api/spotify/callback"


def pkce_pair() -> tuple:
    verifier = secrets.token_urlsafe(64)[:100]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


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
        return bool(self.settings.get("spotify_client_id") and
                    (self.settings.get("spotify_refresh_token") or self.settings.get("spotify_client_secret")))

    def logged_in(self) -> bool:
        return bool(self.settings.get("spotify_client_id") and self.settings.get("spotify_refresh_token"))

    def _http(self) -> httpx.Client:
        return httpx.Client(timeout=15, proxy=self.settings.get("proxy") or None)

    def _token_request(self, data: dict, basic: bool = False) -> dict:
        headers = {}
        if basic:
            creds = f"{self.settings['spotify_client_id']}:{self.settings['spotify_client_secret']}"
            headers["Authorization"] = "Basic " + base64.b64encode(creds.encode()).decode()
        try:
            with self._http() as c:
                r = c.post(TOKEN_URL, data=data, headers=headers)
        except httpx.HTTPError as exc:
            raise SourceError(f"Spotify: нет связи с accounts.spotify.com ({exc})") from exc
        if r.status_code != 200:
            try:
                err = r.json().get("error_description") or r.json().get("error")
            except ValueError:
                err = r.status_code
            raise SourceError(f"Spotify: не удалось авторизоваться ({err})")
        return r.json()

    def _auth(self) -> str:
        if not self.available():
            raise SourceError("Spotify: войдите через Spotify в настройках")
        if self._token and time.time() < self._token_exp - 30:
            return self._token
        if self.settings.get("spotify_refresh_token"):
            data = self._token_request({
                "grant_type": "refresh_token",
                "refresh_token": self.settings["spotify_refresh_token"],
                "client_id": self.settings["spotify_client_id"],
            })
            new_refresh = data.get("refresh_token")
            if new_refresh and new_refresh != self.settings["spotify_refresh_token"]:
                from .. import config  # Spotify может выдать новый refresh-токен — сохраняем

                config.save({"spotify_refresh_token": new_refresh})
                self.settings["spotify_refresh_token"] = new_refresh
        else:
            data = self._token_request({"grant_type": "client_credentials"}, basic=True)
        self._token, self._token_exp = data["access_token"], time.time() + data.get("expires_in", 3600)
        return self._token

    # ---------- вход (Authorization Code + PKCE) ----------
    def authorize_url(self, redirect: str, state: str, challenge: str) -> str:
        if not self.settings.get("spotify_client_id"):
            raise SourceError("Spotify: сначала вставьте Client ID и нажмите «Сохранить»")
        return AUTHORIZE_URL + "?" + urlencode({
            "client_id": self.settings["spotify_client_id"],
            "response_type": "code",
            "redirect_uri": redirect,
            "code_challenge_method": "S256",
            "code_challenge": challenge,
            "state": state,
            "scope": SCOPES,
        })

    def exchange_code(self, code: str, redirect: str, verifier: str) -> dict:
        """Обменивает код на токены. Возвращает {'refresh_token', 'user'}."""
        data = self._token_request({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect,
            "client_id": self.settings["spotify_client_id"],
            "code_verifier": verifier,
        })
        self._token, self._token_exp = data["access_token"], time.time() + data.get("expires_in", 3600)
        self.settings["spotify_refresh_token"] = data.get("refresh_token", "")
        me = self._get("/me")
        return {"refresh_token": data.get("refresh_token", ""),
                "user": me.get("display_name") or me.get("id") or ""}

    def me(self) -> dict:
        me = self._get("/me")
        return {"name": me.get("display_name") or me.get("id") or "", "product": me.get("product") or ""}

    def liked(self, max_items: int = 1000) -> List[Track]:
        items, page = [], self._get("/me/tracks", limit=50)
        while page and len(items) < max_items:
            items += [self._to_track(it["track"]) for it in page.get("items", [])
                      if it.get("track") and it["track"].get("id")]
            page = self._get(page["next"]) if page.get("next") else None
        return items

    def playlists(self) -> List[dict]:
        out, page = [], self._get("/me/playlists", limit=50)
        while page:
            for p in page.get("items", []):
                if not p:
                    continue
                images = p.get("images") or []
                total = (p.get("items") or p.get("tracks") or {}).get("total")
                out.append({"id": p["id"], "name": p.get("name") or "", "count": total,
                            "image": images[0]["url"] if images else "",
                            "owner": (p.get("owner") or {}).get("display_name") or ""})
            page = self._get(page["next"]) if page.get("next") else None
        return out

    def _get(self, path: str, **params) -> dict:
        url = path if path.startswith("http") else API + path
        token = self._auth()
        try:
            with self._http() as c:
                r = c.get(url, params=params or None, headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError as exc:
            raise SourceError(f"Spotify: нет связи с api.spotify.com ({exc})") from exc
        if r.status_code == 403:
            raise SourceError("Spotify: доступ запрещён (403). Проверьте, что ваш аккаунт добавлен "
                              "в User Management приложения на developer.spotify.com")
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
        return self.playlist_tracks(sid)

    def playlist_tracks(self, sid: str) -> List[Track]:
        try:
            page = self._get(f"/playlists/{sid}/items", limit=100)
        except SourceError:
            page = self._get(f"/playlists/{sid}/tracks", limit=100)
        items = []
        while page:
            for it in page.get("items", []):
                t = it.get("track") or it.get("item")
                if t and t.get("id") and t.get("type", "track") == "track":
                    items.append(self._to_track(t))
            page = self._get(page["next"]) if page.get("next") else None
        return items
