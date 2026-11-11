"""Достаёт звук из MPEG-TS без ffmpeg.

Некоторые HLS-потоки (SoundCloud) состоят из TS-сегментов. Без ffmpeg yt-dlp
просто склеивает их, и такой файл не играет в браузере. Здесь мы вынимаем из TS
чистый поток AAC (ADTS) или MP3 — оба браузеры и телефоны играют.
"""
from pathlib import Path

PACKET = 188


def is_ts(data: bytes) -> bool:
    return len(data) >= PACKET * 2 and data[0] == 0x47 and data[PACKET] == 0x47


def extract_audio(data: bytes) -> bytes:
    audio_pids, out = set(), []
    for off in range(0, len(data) - PACKET + 1, PACKET):
        pkt = data[off:off + PACKET]
        if pkt[0] != 0x47:
            continue
        pusi = pkt[1] & 0x40
        pid = ((pkt[1] & 0x1F) << 8) | pkt[2]
        afc = (pkt[3] >> 4) & 3
        if afc in (0, 2):
            continue
        start = 4 + (1 + pkt[4] if afc == 3 else 0)
        payload = pkt[start:]
        if pusi and payload[:3] == b"\x00\x00\x01":
            stream_id = payload[3]
            if 0xC0 <= stream_id <= 0xDF and len(payload) > 9:
                audio_pids.add(pid)
                payload = payload[9 + payload[8]:]
            else:
                continue
        if pid in audio_pids:
            out.append(payload)
    return b"".join(out)


def audio_ext(data: bytes) -> str:
    if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xF0) == 0xF0 and (data[1] & 0x06) == 0:
        return ".aac"
    return ".mp3"


def fix_if_ts(path: Path) -> Path:
    try:
        data = path.read_bytes()
    except OSError:
        return path
    if not is_ts(data):
        return path
    audio = extract_audio(data)
    if not audio:
        return path
    new = path.with_suffix(audio_ext(audio))
    new.write_bytes(audio)
    if new != path:
        path.unlink(missing_ok=True)
    return new
