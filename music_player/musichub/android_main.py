"""Точка входа для Android-приложения (вызывается из Kotlin через Chaquopy).

Сервер слушает только 127.0.0.1 — его видит лишь само приложение.
"""
import os
import threading

_server = None


def start(app_dir: str, download_dir: str, port: int = 8765):
    """Блокирующий запуск сервера. Kotlin вызывает это в отдельном потоке."""
    global _server
    os.environ["MUSICHUB_HOME"] = app_dir
    os.environ["MUSICHUB_DOWNLOAD_DIR"] = download_dir

    import uvicorn
    from .server import create_app

    config = uvicorn.Config(create_app(), host="127.0.0.1", port=int(port), log_config=None,
                            log_level="warning", loop="asyncio", http="h11", lifespan="off")
    _server = uvicorn.Server(config)
    _server.run()


def stop():
    if _server is not None:
        _server.should_exit = True


def start_in_background(app_dir: str, download_dir: str, port: int = 8765) -> threading.Thread:
    t = threading.Thread(target=start, args=(app_dir, download_dir, port), daemon=True)
    t.start()
    return t
