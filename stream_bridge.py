"""H264-поток регистратора по протоколу DVRIP.

Читает DEVICE_HOST, DEVICE_USER и DEVICE_PASSWORD из .env,
входит через библиотеку dvrip и отдаёт кадры H264 на
http://127.0.0.1:5000/stream

Запуск:
    pip install flask python-dotenv
    pip install "git+https://github.com/alexshpilkin/dvrip.git"
    python stream_bridge.py
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, Response, request

from camera_link import CameraError, CameraLink, LoginRejected, encode_h264

load_dotenv(Path(__file__).with_name(".env"))

log = logging.getLogger("stream_bridge")

app = Flask(__name__)


def _env(name: str, *, allow_empty: bool = False) -> str:
    if name not in os.environ:
        raise SystemExit(f"В .env нет переменной {name}")
    value = os.environ[name]
    if not allow_empty and not value.strip():
        raise SystemExit(f"Переменная {name} в .env пустая")
    return value


def _parse_host(raw: str) -> tuple[str, int]:
    value = raw.strip()
    if value.startswith("["):
        host, _, rest = value[1:].partition("]")
        if rest.startswith(":") and rest[1:].isdigit():
            return host, int(rest[1:])
        return host, 34567
    if value.count(":") == 1:
        host, port = value.rsplit(":", 1)
        if port.isdigit():
            return host, int(port)
    return value, 34567


def _stream(channel: int):
    host, port = _parse_host(_env("DEVICE_HOST"))
    try:
        link = CameraLink.open(host, port, _env("DEVICE_USER"), _env("DEVICE_PASSWORD", allow_empty=True))
    except LoginRejected as exc:
        log.warning("%s", exc)
        return
    except (CameraError, OSError) as exc:
        log.warning("Нет связи с регистратором: %s", exc)
        return
    log.info("Подключено к %s:%s", host, port)
    try:
        yield from encode_h264(link.frames(channel))
    finally:
        link.close()


@app.get("/")
def index():
    channel = request.args.get("channel", default=0, type=int)
    return f"""<!doctype html>
<meta charset="utf-8">
<title>DVR stream</title>
<style>
  html, body {{ margin: 0; background: #111; height: 100%; }}
  canvas {{ width: 100%; height: 100%; object-fit: contain; background: #000; }}
</style>
<canvas id="view"></canvas>
<script src="/static/h264.js"></script>
<script>playH264(document.querySelector("#view"), "/stream?channel={channel}");</script>
"""


@app.get("/stream")
def stream():
    channel = request.args.get("channel", default=0, type=int)
    return Response(
        _stream(channel),
        mimetype="application/octet-stream",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    app.run(host="127.0.0.1", port=5000, threaded=True)
