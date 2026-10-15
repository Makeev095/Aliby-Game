"""MJPEG-мост к регистратору XMeye.

CLOUD_ID — серийный номер устройства в облаке. Отдельного пакета
pyXMEye нет. dvrip и go2rtc говорят с регистратором по DVRIP
(TCP, порт 34567) и не входят в облако Xiongmai по серийному номеру.

Откуда берутся кадры, по порядку:
1. Бинарник из P2P_CLIENT (по умолчанию p2p-client), если он есть в PATH.
   Ему передаётся CLOUD_ID, логин уходит через окружение. Ожидается,
   что он сам поднимет RTSP на 127.0.0.1:8554/cam.
2. go2rtc, если он установлен и в .env задан DEVICE_HOST.
   Источник: dvrip://USER:PASSWORD@DEVICE_HOST:34567
3. Иначе напрямую H264 через библиотеку dvrip на DEVICE_HOST.

Без локального адреса и без p2p-client картинки не будет:
облачный P2P из этих библиотек не собирается.

Запуск:
    pip install flask python-dotenv opencv-python-headless
    pip install "git+https://github.com/alexshpilkin/dvrip.git"
    python rtsp_server.py
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import quote

import cv2
from dotenv import load_dotenv
from flask import Flask, Response

load_dotenv(Path(__file__).with_name(".env"))

os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

log = logging.getLogger("rtsp_server")

HOST = "127.0.0.1"
PORT = 5001
BOUNDARY = "frame"
LOCAL_RTSP = "rtsp://127.0.0.1:8554/cam"
JPEG_QUALITY = 80
OPEN_TIMEOUT_MS = 10_000
READ_TIMEOUT_MS = 10_000

UNAVAILABLE = (
    "По серийному номеру поток не открыть: нужен адрес регистратора "
    "в DEVICE_HOST или клиент p2p-client (переменная P2P_CLIENT), "
    "который поднимет локальный RTSP."
)

app = Flask(__name__)
_bridge_lock = threading.Lock()
_bridge: "LocalBridge | None" = None


def _env(name: str) -> str:
    if name not in os.environ:
        raise SystemExit(f"В .env нет переменной {name}")
    value = os.environ[name].strip()
    if not value:
        raise SystemExit(f"Переменная {name} в .env пустая")
    return value


def _optional(name: str) -> str:
    return os.environ.get(name, "").strip()


def _which(name: str) -> str | None:
    local = Path(__file__).with_name("bin") / name
    if local.is_file() and os.access(local, os.X_OK):
        return str(local)
    return shutil.which(name)


def _parse_host(raw: str) -> tuple[str, int | None]:
    """host:port или строка ngrok вида tcp://0.tcp.ngrok.io:12345."""
    value = raw.strip()
    if "://" in value:
        value = value.split("://", 1)[1]
    value = value.strip().strip("/")
    if value.count(":") == 1:
        host, port = value.rsplit(":", 1)
        if port.isdigit():
            return host, int(port)
    return value, None


class LocalBridge:
    def __init__(self, proc: subprocess.Popen, rtsp_url: str):
        self.proc = proc
        self.rtsp_url = rtsp_url

    @property
    def alive(self) -> bool:
        return self.proc.poll() is None


def start_p2p_client() -> LocalBridge | None:
    """Запускает внешний P2P-клиент по серийному номеру, если бинарник есть.

    Пароль не попадает в аргументы процесса, только в окружение дочернего
    процесса: CAMERA_USER и CAMERA_PASSWORD.
    """
    name = _optional("P2P_CLIENT") or "p2p-client"
    binary = _which(name)
    if binary is None:
        return None

    cloud_id = _env("CLOUD_ID")
    env = os.environ.copy()
    env["CAMERA_USER"] = _env("USER")
    env["CAMERA_PASSWORD"] = _env("PASSWORD")
    log.info("Запуск %s для Cloud ID %s", binary, cloud_id)
    proc = subprocess.Popen(
        [binary, "--serial", cloud_id, "--listen", "127.0.0.1:8554"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    return LocalBridge(proc, LOCAL_RTSP)


def start_go2rtc(host: str) -> LocalBridge | None:
    """Поднимает go2rtc с источником dvrip:// на локальный RTSP.

    go2rtc не принимает Cloud ID. Нужен обычный адрес регистратора.
    """
    binary = _which("go2rtc")
    if binary is None:
        return None

    user = quote(_env("USER"), safe="")
    password = quote(_env("PASSWORD"), safe="")
    address, port = _parse_host(host)
    source = (
        f"dvrip://{user}:{password}@{address}:{port or 34567}"
        "?channel=0&subtype=0"
    )
    cfg_path = Path(__file__).with_name("go2rtc.yaml")
    cfg_path.write_text(
        "api:\n"
        "  listen: 127.0.0.1:1984\n"
        "rtsp:\n"
        "  listen: 127.0.0.1:8554\n"
        "streams:\n"
        f"  cam: {source}\n",
        encoding="utf-8",
    )
    os.chmod(cfg_path, 0o600)
    log.info("Запуск go2rtc, DVRIP %s:%s", address, port or 34567)
    proc = subprocess.Popen(
        [binary, "-config", str(cfg_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    return LocalBridge(proc, LOCAL_RTSP)


def ensure_bridge() -> LocalBridge | None:
    """Один локальный мост на процесс: p2p-client, иначе go2rtc."""
    global _bridge
    with _bridge_lock:
        if _bridge is not None and _bridge.alive:
            return _bridge
        _bridge = start_p2p_client()
        if _bridge is None and _optional("DEVICE_HOST"):
            _bridge = start_go2rtc(_optional("DEVICE_HOST"))
        return _bridge


def h264_from_dvrip(host: str):
    """Живой H264 регистратора через библиотеку dvrip."""
    from camera_link import CameraError, CameraLink, LoginRejected, encode_h264

    address, port = _parse_host(host)
    try:
        link = CameraLink.open(address, port or 34567, _env("USER"), _env("PASSWORD"))
    except LoginRejected as exc:
        log.warning("%s", exc)
        return
    except (CameraError, OSError) as exc:
        log.warning("DVRIP: %s", exc)
        return
    log.info("DVRIP подключён к %s", address)
    try:
        yield from encode_h264(link.frames(0))
    finally:
        link.close()


def _part(payload: bytes) -> bytes:
    return (
        b"--" + BOUNDARY.encode() + b"\r\n"
        b"Content-Type: image/jpeg\r\n"
        b"Content-Length: " + str(len(payload)).encode() + b"\r\n\r\n"
        + payload
        + b"\r\n"
    )


def mjpeg_from_rtsp(url: str):
    """Читает локальный RTSP (его поднял p2p-client или go2rtc) и кодирует JPEG."""
    cap = cv2.VideoCapture()
    cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, OPEN_TIMEOUT_MS)
    cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, READ_TIMEOUT_MS)
    if not cap.open(url, cv2.CAP_FFMPEG):
        log.error("Локальный RTSP не открылся")
        cap.release()
        return
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                log.warning("Кадр из локального RTSP не получен")
                break
            ok, jpeg = cv2.imencode(
                ".jpg",
                frame,
                [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY],
            )
            if not ok:
                continue
            yield _part(jpeg.tobytes())
    finally:
        cap.release()


def mjpeg_frames():
    """Внешний мост по Cloud ID. Прямой адрес идёт отдельным H264-потоком."""
    bridge = ensure_bridge()
    if bridge is not None:
        yield from mjpeg_from_rtsp(bridge.rtsp_url)
        return
    log.error(UNAVAILABLE)


def mjpeg():
    while True:
        yield from mjpeg_frames()
        if not _optional("DEVICE_HOST") and ensure_bridge() is None:
            return
        time.sleep(2)


def _page(message: str, live: bool, h264: bool = False) -> str:
    if h264:
        view = '<canvas id="view"></canvas><script src="/static/h264.js"></script><script>playH264(document.querySelector("#view"), "/stream");</script>'
    elif live:
        view = '<img src="/stream" alt="camera">'
    else:
        view = ""
    return f"""<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Камера</title>
  <style>
    html, body {{ margin: 0; background: #111; color: #ddd; font: 16px/1.4 sans-serif; }}
    img, canvas {{ width: 100%; height: 100vh; object-fit: contain; background: #000; }}
    p {{ max-width: 42rem; margin: 2rem auto; padding: 0 1rem; }}
  </style>
</head>
<body>
  <p>{message}</p>
  {view}
</body>
</html>
"""


def _live() -> bool:
    return ensure_bridge() is not None or bool(_optional("DEVICE_HOST"))


def _direct_host() -> str:
    if ensure_bridge() is not None:
        return ""
    return _optional("DEVICE_HOST")


@app.get("/")
def index():
    if ensure_bridge() is not None:
        return _page("Поток с регистратора.", True)
    if _optional("DEVICE_HOST"):
        return _page("Поток H264 с регистратора.", True, h264=True)
    return _page(UNAVAILABLE, False)


@app.get("/stream")
def stream():
    host = _direct_host()
    if host:
        return Response(
            h264_from_dvrip(host),
            mimetype="application/octet-stream",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate", "X-Accel-Buffering": "no"},
        )
    if not _live():
        return Response(UNAVAILABLE, status=503, content_type="text/plain; charset=utf-8")
    return Response(
        mjpeg(),
        mimetype=f"multipart/x-mixed-replace; boundary={BOUNDARY}",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    _env("CLOUD_ID")
    _env("USER")
    _env("PASSWORD")
    app.run(host=HOST, port=PORT, threaded=True)
