"""Настройки хранятся в ~/.musichub/settings.json."""
import json
import os
from pathlib import Path

APP_DIR = Path(os.environ.get("MUSICHUB_HOME", Path.home() / ".musichub"))
SETTINGS_FILE = APP_DIR / "settings.json"
CACHE_DIR = APP_DIR / "cache"

DEFAULTS = {
    "download_dir": os.environ.get("MUSICHUB_DOWNLOAD_DIR") or str(Path.home() / "Music" / "MusicHub"),
    "yandex_token": "",
    "spotify_client_id": "",
    "spotify_client_secret": "",
    # прокси для исходящих запросов (необязательно), например socks5://host:port
    "proxy": "",
}

SECRET_KEYS = ("yandex_token", "spotify_client_secret")
MASK = "••••"


def load() -> dict:
    data = dict(DEFAULTS)
    if SETTINGS_FILE.exists():
        try:
            data.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            pass
    return data


def save(new_values: dict) -> dict:
    data = load()
    for k, v in new_values.items():
        if k in DEFAULTS and isinstance(v, str) and v != MASK:
            v = v.strip()
            if k == "yandex_token" and v:
                from .sources.yandex import extract_token

                v = extract_token(v) or v
            data[k] = v
    APP_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def public_view(data: dict) -> dict:
    """Настройки для отдачи в браузер: секреты не показываем, только факт наличия."""
    out = {}
    for k, v in data.items():
        out[k] = (MASK if v else "") if k in SECRET_KEYS else v
    return out


def ffmpeg_path():
    """ffmpeg рядом с программой (сборка .exe), в MUSICHUB_FFMPEG или в PATH. None — если его нет."""
    import shutil
    import sys

    candidates = [os.environ.get("MUSICHUB_FFMPEG", "")]
    for base in (getattr(sys, "_MEIPASS", ""), os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else ""):
        if base:
            candidates += [os.path.join(base, "ffmpeg.exe"), os.path.join(base, "ffmpeg")]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return shutil.which("ffmpeg")
