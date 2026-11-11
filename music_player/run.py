"""Запуск MusicHub.

    python run.py              — только на этом компьютере, откроется окно/браузер
    python run.py --lan        — доступ с телефона в той же Wi-Fi сети
    python run.py --lan --password 1234   — то же, но с паролем
    python run.py --window     — отдельное окно вместо браузера (нужен pywebview)
    python run.py --browser    — открыть в браузере

Готовый MusicHub.exe понимает те же параметры (можно прописать в ярлыке).
"""
import argparse
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser

FROZEN = getattr(sys, "frozen", False)


def setup_windowed_logging():
    """В .exe без консоли stdout/stderr = None — пишем лог в файл, иначе uvicorn упадёт."""
    if sys.stdout is None or sys.stderr is None:
        from musichub import config

        config.APP_DIR.mkdir(parents=True, exist_ok=True)
        log = open(config.APP_DIR / "musichub.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or log
        sys.stderr = sys.stderr or log


def lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def wait_ready(url: str, timeout: float = 15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            urllib.request.urlopen(url + "/static/icon.svg", timeout=1)
            return True
        except Exception:
            time.sleep(0.2)
    return False


def main():
    setup_windowed_logging()
    p = argparse.ArgumentParser(description="MusicHub — музыкальный плеер")
    p.add_argument("--lan", action="store_true", help="открыть доступ из локальной сети (для телефона)")
    p.add_argument("--host", default=None, help="адрес для прослушивания (по умолчанию 127.0.0.1, с --lan 0.0.0.0)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--password", default=os.environ.get("MUSICHUB_PASSWORD", ""), help="пароль для входа")
    p.add_argument("--window", action="store_true", help="открыть в отдельном окне (pip install pywebview)")
    p.add_argument("--browser", action="store_true", help="открыть в браузере (по умолчанию для python run.py)")
    p.add_argument("--no-browser", action="store_true", help="только сервер, ничего не открывать")
    args = p.parse_args()

    host = args.host or ("0.0.0.0" if args.lan else "127.0.0.1")
    if args.password:
        os.environ["MUSICHUB_PASSWORD"] = args.password
    elif host != "127.0.0.1":
        print("ВНИМАНИЕ: сервер открыт в сеть без пароля. Лучше добавьте --password <пароль>.")

    import uvicorn
    from musichub.server import create_app

    app = create_app()
    url = f"http://127.0.0.1:{args.port}"
    print(f"\nMusicHub запущен: {url}")
    if host == "0.0.0.0":
        print(f"С телефона (та же Wi-Fi сеть): http://{lan_ip()}:{args.port}")
    print("Остановить: Ctrl+C\n")

    server = uvicorn.Server(uvicorn.Config(app, host=host, port=args.port, log_level="warning"))
    use_window = args.window or (FROZEN and not args.browser and not args.no_browser)

    if use_window:
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        wait_ready(url)
        try:
            import webview  # pywebview

            webview.create_window("MusicHub", url, width=1100, height=760, min_size=(380, 500))
            webview.start()
            server.should_exit = True
            thread.join(timeout=5)
            return
        except Exception as exc:  # нет WebView2 и т.п. — откроем обычный браузер
            print(f"Окно не открылось ({exc}), открываю браузер")
            webbrowser.open(url)
            thread.join()
            return

    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    server.run()


if __name__ == "__main__":
    main()
