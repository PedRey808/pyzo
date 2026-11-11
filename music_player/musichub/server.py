"""HTTP-сервер: API + веб-интерфейс (работает в браузере ПК, телефона и внутри Android-приложения).

Используется Starlette без pydantic — так весь проект остаётся на чистом Python
и собирается и в .exe, и в Android-приложение.
"""
import base64
import os
import secrets
from pathlib import Path

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import config
from .service import MusicHub
from .sources.base import SourceError

STATIC = Path(__file__).parent / "static"
MEDIA_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".opus": "audio/ogg", ".ogg": "audio/ogg",
               ".flac": "audio/flac", ".wav": "audio/wav", ".webm": "audio/webm"}


class HTTPError(Exception):
    def __init__(self, status: int, detail: str):
        self.status, self.detail = status, detail


class BasicAuth(BaseHTTPMiddleware):
    """Пароль нужен, когда сервер доступен из сети (телефон, VPS)."""

    def __init__(self, app, password: str):
        super().__init__(app)
        self.password = password

    async def dispatch(self, request, call_next):
        if self.password:
            ok = False
            header = request.headers.get("authorization", "")
            if header.startswith("Basic "):
                try:
                    _, _, given = base64.b64decode(header[6:]).decode().partition(":")
                    ok = secrets.compare_digest(given, self.password)
                except Exception:
                    ok = False
            if not ok:
                return Response("Нужен пароль", status_code=401,
                                headers={"WWW-Authenticate": 'Basic realm="MusicHub", charset="UTF-8"'})
        return await call_next(request)


def media(path: Path, download_name: str = None) -> FileResponse:
    return FileResponse(path, media_type=MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"),
                        filename=download_name,
                        content_disposition_type="attachment" if download_name else "inline")


def create_app(hub: MusicHub = None) -> Starlette:
    hub = hub or MusicHub()

    def endpoint(fn, needs_body=False):
        """Обёртка: блокирующая логика в отдельном потоке, ошибки — в JSON."""
        async def handler(request: Request):
            try:
                args = [request]
                if needs_body:
                    try:
                        args.append(await request.json())
                    except ValueError:
                        raise HTTPError(400, "Ожидался JSON")
                result = await run_in_threadpool(fn, *args)
            except HTTPError as exc:
                return JSONResponse({"detail": exc.detail}, status_code=exc.status)
            except SourceError as exc:
                return JSONResponse({"detail": str(exc)}, status_code=502)
            except KeyError:
                return JSONResponse({"detail": "Трек не найден — повторите поиск"}, status_code=404)
            return result if isinstance(result, Response) else JSONResponse(result)
        return handler

    def index(_):
        return FileResponse(STATIC / "index.html")

    def service_worker(_):
        return FileResponse(STATIC / "sw.js", media_type="application/javascript")

    def sources(_):
        return hub.sources_info()

    def search(req):
        q = req.query_params.get("q", "")
        try:
            limit = max(1, min(int(req.query_params.get("limit", 10)), 25))
        except ValueError:
            limit = 10
        return hub.search(q, req.query_params.get("source", "all"), limit)

    def import_url(_, body):
        return hub.import_url(str(body.get("url", "")))

    def prepare(_, body):
        """Зарегистрировать трек и подготовить аудио (скачать в кэш)."""
        t = hub.register(body)
        hub.cached_audio(t.key)
        return {"key": t.key, "audio": f"/api/audio/{t.key}"}

    def audio(req):
        return media(hub.cached_audio(req.path_params["key"]))

    def download(_, body):
        """Сохранить трек в папку загрузок."""
        t = hub.register(body)
        path = hub.download(t.key)
        return {"path": str(path), "name": path.name}

    def file_for_device(req):
        """Отдать файл браузеру как загрузку (например, чтобы сохранить на телефон)."""
        path = hub.download(req.path_params["key"])
        return media(path, path.name)

    def library(_):
        return hub.library()

    def library_file(req):
        path = hub.library_file(req.path_params["name"])
        if path is None:
            raise HTTPError(404, "Файл не найден")
        attach = req.query_params.get("attachment") in ("1", "true")
        return media(path, path.name if attach else None)

    def get_settings(_):
        return config.public_view(hub.settings)

    def set_settings(_, body):
        if not isinstance(body, dict):
            raise HTTPError(400, "Ожидался объект настроек")
        return hub.update_settings(body)

    routes = [
        Route("/", index),
        Route("/sw.js", service_worker),
        Route("/api/sources", endpoint(sources)),
        Route("/api/search", endpoint(search)),
        Route("/api/import", endpoint(import_url, True), methods=["POST"]),
        Route("/api/prepare", endpoint(prepare, True), methods=["POST"]),
        Route("/api/audio/{key:path}", endpoint(audio)),
        Route("/api/download", endpoint(download, True), methods=["POST"]),
        Route("/api/file/{key:path}", endpoint(file_for_device)),
        Route("/api/library", endpoint(library)),
        Route("/api/library/{name}", endpoint(library_file)),
        Route("/api/settings", endpoint(get_settings)),
        Route("/api/settings", endpoint(set_settings, True), methods=["POST"]),
        Mount("/static", StaticFiles(directory=STATIC), name="static"),
    ]
    middleware = [Middleware(BasicAuth, password=os.environ.get("MUSICHUB_PASSWORD", ""))]
    app = Starlette(routes=routes, middleware=middleware)
    app.state.hub = hub
    return app
