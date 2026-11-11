from dataclasses import dataclass, asdict
from typing import Optional


@dataclass
class Track:
    source: str            # soundcloud | yandex | spotify | youtube
    id: str                # id внутри источника
    title: str
    artist: str = ""
    duration: Optional[int] = None   # секунды
    artwork: str = ""
    url: str = ""          # страница трека (для yt-dlp — то, что качаем)
    protected: bool = False  # источник не отдаёт звук (DRM, только отрывок) — ищем в других

    @property
    def key(self) -> str:
        return f"{self.source}:{self.id}"

    @property
    def full_name(self) -> str:
        return f"{self.artist} - {self.title}" if self.artist else self.title

    def to_dict(self) -> dict:
        d = asdict(self)
        d["key"] = self.key
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Track":
        fields = cls.__dataclass_fields__
        return cls(**{k: v for k, v in d.items() if k in fields})
