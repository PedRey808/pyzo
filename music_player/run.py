"""Запуск MusicHub.

    python run.py              — только на этом компьютере, откроется браузер
    python run.py --lan        — доступ с телефона в той же Wi-Fi сети
    python run.py --lan --password 1234   — то же, но с паролем
    python run.py --window     — отдельное окно вместо браузера (нужен pywebview)
"""
import argparse
import os
import socket
import threading
import webbrowser


def lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def main():
    p = argparse.ArgumentParser(description="MusicHub — музыкальный плеер")
    p.add_argument("--lan", action="store_true", help="открыть доступ из локальной сети (для телефона)")
    p.add_argument("--host", default=None, help="адрес для прослушивания (по умолчанию 127.0.0.1, с --lan 0.0.0.0)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--password", default=os.environ.get("MUSICHUB_PASSWORD", ""), help="пароль для входа")
    p.add_argument("--window", action="store_true", help="открыть в отдельном окне (pip install pywebview)")
    p.add_argument("--no-browser", action="store_true")
    args = p.parse_args()

    host = args.host or ("0.0.0.0" if args.lan else "127.0.0.1")
    if args.password:
        os.environ["MUSICHUB_PASSWORD"] = args.password
    elif host != "127.0.0.1":
        print("ВНИМАНИЕ: сервер открыт в сеть без пароля. Лучше добавьте --password <пароль>.")

    import uvicorn
    from app.server import create_app

    app = create_app()
    url = f"http://127.0.0.1:{args.port}"
    print(f"\nMusicHub запущен: {url}")
    if host == "0.0.0.0":
        print(f"С телефона (та же Wi-Fi сеть): http://{lan_ip()}:{args.port}")
    print("Остановить: Ctrl+C\n")

    if args.window:
        import webview  # pywebview
        server = uvicorn.Server(uvicorn.Config(app, host=host, port=args.port, log_level="warning"))
        threading.Thread(target=server.run, daemon=True).start()
        webview.create_window("MusicHub", url, width=1100, height=760)
        webview.start()
        server.should_exit = True
        return

    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
