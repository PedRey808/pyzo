"""Настройки хранятся в ~/.musichub/settings.json."""
import json
import os
from pathlib import Path

APP_DIR = Path(os.environ.get("MUSICHUB_HOME", Path.home() / ".musichub"))
SETTINGS_FILE = APP_DIR / "settings.json"
CACHE_DIR = APP_DIR / "cache"

DEFAULTS = {
    "download_dir": str(Path.home() / "Music" / "MusicHub"),
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
            data[k] = v.strip()
    APP_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def public_view(data: dict) -> dict:
    """Настройки для отдачи в браузер: секреты не показываем, только факт наличия."""
    out = {}
    for k, v in data.items():
        out[k] = (MASK if v else "") if k in SECRET_KEYS else v
    return out
