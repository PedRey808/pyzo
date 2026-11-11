from pathlib import Path
from typing import List

from ..models import Track


class SourceError(Exception):
    """Понятная пользователю ошибка источника (нет токена, трек недоступен и т.п.)."""


class Source:
    name = ""
    title = ""

    def __init__(self, settings: dict):
        self.settings = settings

    def available(self) -> bool:
        return True

    def search(self, query: str, limit: int = 10) -> List[Track]:
        raise NotImplementedError

    def fetch_audio(self, track: Track, dest: Path) -> Path:
        """Скачать аудио трека. dest — путь без расширения; возвращает итоговый файл."""
        raise NotImplementedError
