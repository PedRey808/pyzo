"""Тесты без сети: источники подменяются фейковыми.

Запуск из папки music_player:  python -m unittest discover tests
"""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.mkdtemp()
os.environ["MUSICHUB_HOME"] = TMP

from musichub import config  # noqa: E402
from musichub.matcher import best_match, score  # noqa: E402
from musichub.models import Track  # noqa: E402
from musichub.service import MusicHub, safe_filename  # noqa: E402
from musichub.sources.base import Source, SourceError  # noqa: E402
from musichub.sources.spotify import parse_spotify_url  # noqa: E402


def make_mp3(path: Path):
    if shutil.which("ffmpeg"):
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                        "-q:a", "9", str(path)], check=True)
    else:
        path.write_bytes(b"ID3fake")
    return path


class FakeSource(Source):
    def __init__(self, name, tracks, fail=False):
        super().__init__({})
        self.name, self.title, self.tracks, self.fail = name, name, tracks, fail
        self.fetched = []

    def search(self, query, limit=10):
        if self.fail:
            raise SourceError(f"{self.name} недоступен")
        return self.tracks[:limit]

    def fetch_audio(self, track, dest):
        self.fetched.append(track.key)
        return make_mp3(dest.with_suffix(".mp3"))


def fake_hub():
    hub = MusicHub()
    sc = Track("soundcloud", "1", "Get Lucky", "Daft Punk", 248, url="https://sc/1")
    hub.sources = {
        "yandex": FakeSource("yandex", [], fail=True),
        "soundcloud": FakeSource("soundcloud", [sc, Track("soundcloud", "2", "Something else", "Nobody", 100)]),
        "spotify": FakeSource("spotify", [Track("spotify", "abc", "Get Lucky", "Daft Punk", 249)]),
        "youtube": FakeSource("youtube", []),
    }
    return hub


class MatcherTests(unittest.TestCase):
    def test_best_match_prefers_title_and_duration(self):
        target = Track("spotify", "x", "Get Lucky", "Daft Punk", 248)
        good = Track("soundcloud", "1", "Daft Punk - Get Lucky (Official Audio)", "uploader", 250)
        bad = Track("soundcloud", "2", "Get Lucky cover", "Random", 120)
        self.assertIs(best_match(target, [bad, good]), good)
        self.assertGreater(score(target, good), score(target, bad))

    def test_no_match_below_threshold(self):
        target = Track("spotify", "x", "Get Lucky", "Daft Punk", 248)
        self.assertIsNone(best_match(target, [Track("youtube", "z", "Совсем другое", "Кто-то", 30)]))


class UtilsTests(unittest.TestCase):
    def test_parse_spotify_url(self):
        self.assertEqual(parse_spotify_url("https://open.spotify.com/playlist/37i9dQZF1?si=xx"), ("playlist", "37i9dQZF1"))
        self.assertEqual(parse_spotify_url("https://open.spotify.com/intl-ru/track/abc123"), ("track", "abc123"))
        self.assertEqual(parse_spotify_url("spotify:album:Z9"), ("album", "Z9"))
        self.assertIsNone(parse_spotify_url("daft punk"))

    def test_safe_filename(self):
        self.assertEqual(safe_filename('AC/DC: "Back" <in> Black?'), "AC_DC_ _Back_ _in_ Black_")
        self.assertEqual(safe_filename("..."), "track")

    def test_settings_mask_secrets(self):
        config.save({"yandex_token": "secret", "proxy": ""})
        view = config.public_view(config.load())
        self.assertEqual(view["yandex_token"], config.MASK)
        config.save({"yandex_token": config.MASK})  # маска из формы не затирает токен
        self.assertEqual(config.load()["yandex_token"], "secret")
        config.save({"yandex_token": ""})


class YandexLoginTests(unittest.TestCase):
    def test_extract_token(self):
        from musichub.sources.yandex import extract_token

        url = "https://music.yandex.ru/#access_token=y0_AgAAAABC-def_123&token_type=bearer&expires_in=31536000"
        self.assertEqual(extract_token(url), "y0_AgAAAABC-def_123")
        self.assertEqual(extract_token("  y0_AgAAAAAbcdefghijklmnop  "), "y0_AgAAAAAbcdefghijklmnop")
        self.assertIsNone(extract_token("https://music.yandex.ru/"))
        self.assertIsNone(extract_token(""))

    def test_settings_accept_redirect_url(self):
        config.save({"yandex_token": "https://music.yandex.ru/#access_token=y0_TOKEN123456789012345&token_type=bearer"})
        self.assertEqual(config.load()["yandex_token"], "y0_TOKEN123456789012345")
        config.save({"yandex_token": ""})

    def test_account_endpoint(self):
        from starlette.testclient import TestClient
        from musichub.server import create_app

        hub = fake_hub()
        hub.sources["yandex"].account_info = lambda: {"login": "ivan", "name": "Иван", "plus": True}
        r = TestClient(create_app(hub)).get("/api/yandex/account")
        self.assertEqual(r.json(), {"login": "ivan", "name": "Иван", "plus": True})

    def test_account_endpoint_without_token(self):
        from starlette.testclient import TestClient
        from musichub.server import create_app

        config.save({"yandex_token": ""})
        r = TestClient(create_app(MusicHub())).get("/api/yandex/account")
        self.assertEqual(r.status_code, 502)
        self.assertIn("токен", r.json()["detail"])


class ServiceTests(unittest.TestCase):
    def setUp(self):
        config.save({"download_dir": str(Path(TMP) / "downloads")})
        shutil.rmtree(config.CACHE_DIR, ignore_errors=True)
        self.hub = fake_hub()

    def test_search_all_collects_errors_per_source(self):
        res = self.hub.search("daft punk")
        self.assertEqual(len(res["results"]["soundcloud"]), 2)
        self.assertIn("yandex", res["errors"])

    def test_spotify_track_is_played_via_other_source(self):
        self.hub.search("get lucky", source="spotify")
        path = self.hub.cached_audio("spotify:abc")
        self.assertTrue(path.exists())
        self.assertEqual(self.hub.sources["soundcloud"].fetched, ["soundcloud:1"])
        self.hub.cached_audio("spotify:abc")  # второй раз — из кэша
        self.assertEqual(len(self.hub.sources["soundcloud"].fetched), 1)

    def test_download_saves_named_file(self):
        self.hub.search("daft", source="soundcloud")
        path = self.hub.download("soundcloud:1")
        self.assertEqual(path.name, "Daft Punk - Get Lucky.mp3")
        self.assertEqual(self.hub.library()[0]["title"], "Get Lucky")
        self.assertIsNone(self.hub.library_file("../settings.json"))


class ServerTests(unittest.TestCase):
    def setUp(self):
        from starlette.testclient import TestClient
        from musichub.server import create_app

        config.save({"download_dir": str(Path(TMP) / "downloads2")})
        self.client = TestClient(create_app(fake_hub()))

    def test_flow(self):
        c = self.client
        self.assertIn("MusicHub", c.get("/").text)
        data = c.get("/api/search", params={"q": "daft", "source": "soundcloud"}).json()
        track = data["results"]["soundcloud"][0]
        prep = c.post("/api/prepare", json=track).json()
        audio = c.get(prep["audio"])
        self.assertEqual(audio.status_code, 200)
        self.assertEqual(audio.headers["content-type"], "audio/mpeg")
        saved = c.post("/api/download", json=track).json()
        self.assertTrue(Path(saved["path"]).exists())
        f = c.get("/api/file/" + track["key"])
        self.assertIn("attachment", f.headers["content-disposition"])
        self.assertEqual(c.get("/api/library").json()[0]["name"], saved["name"])
        self.assertEqual(c.get("/api/audio/soundcloud:404").status_code, 404)

    def test_source_error_is_readable(self):
        r = self.client.get("/api/search", params={"q": "x", "source": "nope"})
        self.assertEqual(r.status_code, 502)
        self.assertIn("Неизвестный источник", r.json()["detail"])

    def test_password(self):
        from starlette.testclient import TestClient
        from musichub.server import create_app

        os.environ["MUSICHUB_PASSWORD"] = "pw"
        try:
            c = TestClient(create_app(fake_hub()))
            self.assertEqual(c.get("/api/sources").status_code, 401)
            self.assertEqual(c.get("/api/sources", auth=("u", "pw")).status_code, 200)
        finally:
            del os.environ["MUSICHUB_PASSWORD"]


class TsDemuxTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("ffmpeg"), "нужен ffmpeg")
    def test_extracts_aac_from_ts(self):
        from musichub.tsdemux import fix_if_ts

        src = Path(TMP) / "seg.m4a"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1",
                        "-c:a", "aac", "-f", "mpegts", str(src)], check=True)
        out = fix_if_ts(src)
        self.assertEqual(out.suffix, ".aac")
        self.assertFalse(src.exists())
        self.assertEqual(out.read_bytes()[0], 0xFF)

    def test_non_ts_untouched(self):
        from musichub.tsdemux import fix_if_ts

        p = Path(TMP) / "plain.mp3"
        p.write_bytes(b"ID3" + b"\0" * 500)
        self.assertEqual(fix_if_ts(p), p)


if __name__ == "__main__":
    unittest.main()
