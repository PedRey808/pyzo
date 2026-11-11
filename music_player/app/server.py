"""HTTP-сервер: API + веб-интерфейс (работает в браузере ПК и телефона)."""
import base64
import os
import secrets
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .service import MusicHub
from .sources.base import SourceError

STATIC = Path(__file__).parent / "static"
MEDIA_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".opus": "audio/ogg", ".ogg": "audio/ogg",
               ".flac": "audio/flac", ".wav": "audio/wav", ".webm": "audio/webm"}


def create_app(hub: MusicHub = None) -> FastAPI:
    app = FastAPI(title="MusicHub")
    app.state.hub = hub or MusicHub()
    password = os.environ.get("MUSICHUB_PASSWORD", "")

    @app.middleware("http")
    async def basic_auth(request: Request, call_next):
        # пароль нужен, когда сервер доступен из сети (телефон, VPS)
        if password:
            ok = False
            header = request.headers.get("authorization", "")
            if header.startswith("Basic "):
                try:
                    _, _, given = base64.b64decode(header[6:]).decode().partition(":")
                    ok = secrets.compare_digest(given, password)
                except Exception:
                    ok = False
            if not ok:
                return Response("Нужен пароль", status_code=401,
                                headers={"WWW-Authenticate": 'Basic realm="MusicHub", charset="UTF-8"'})
        return await call_next(request)

    @app.exception_handler(SourceError)
    async def source_error(_, exc: SourceError):
        return JSONResponse({"detail": str(exc)}, status_code=502)

    def hub_() -> MusicHub:
        return app.state.hub

    def media(path: Path, download_name: str = None) -> FileResponse:
        return FileResponse(path, media_type=MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"),
                            filename=download_name,
                            content_disposition_type="attachment" if download_name else "inline")

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/sw.js")
    def service_worker():
        return FileResponse(STATIC / "sw.js", media_type="application/javascript")

    @app.get("/api/sources")
    def sources():
        return hub_().sources_info()

    @app.get("/api/search")
    def search(q: str, source: str = "all", limit: int = 10):
        return hub_().search(q, source, max(1, min(limit, 25)))

    @app.post("/api/import")
    def import_url(url: str = Body(..., embed=True)):
        return hub_().import_url(url)

    @app.post("/api/prepare")
    def prepare(track: dict = Body(...)):
        """Зарегистрировать трек и подготовить аудио (скачать в кэш)."""
        t = hub_().register(track)
        hub_().cached_audio(t.key)
        return {"key": t.key, "audio": f"/api/audio/{t.key}"}

    @app.get("/api/audio/{key:path}")
    def audio(key: str):
        try:
            return media(hub_().cached_audio(key))
        except KeyError:
            raise HTTPException(404, "Трек не найден — повторите поиск")

    @app.post("/api/download")
    def download(track: dict = Body(...)):
        """Сохранить трек в папку загрузок на компьютере."""
        t = hub_().register(track)
        path = hub_().download(t.key)
        return {"path": str(path), "name": path.name}

    @app.get("/api/file/{key:path}")
    def file_for_device(key: str):
        """Отдать файл браузеру как загрузку (например, чтобы сохранить на телефон)."""
        try:
            path = hub_().download(key)
        except KeyError:
            raise HTTPException(404, "Трек не найден — повторите поиск")
        return media(path, path.name)

    @app.get("/api/library")
    def library():
        return hub_().library()

    @app.get("/api/library/{name}")
    def library_file(name: str, attachment: bool = False):
        path = hub_().library_file(name)
        if path is None:
            raise HTTPException(404, "Файл не найден")
        return media(path, path.name if attachment else None)

    @app.get("/api/settings")
    def get_settings():
        from . import config
        return config.public_view(hub_().settings)

    @app.post("/api/settings")
    def set_settings(values: dict = Body(...)):
        return hub_().update_settings(values)

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app
