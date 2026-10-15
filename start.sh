#!/bin/bash
# Ноутбук: Flask и go2rtc. DEVICE_HOST — адрес регистратора или публичный TCP ngrok.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ ! -x "$ROOT/bin/go2rtc" ]]; then
  echo "Нет bin/go2rtc. Сначала выполните ./setup_p2p.sh" >&2
  exit 1
fi

python3 - <<'PY'
from rtsp_server import _optional, _parse_host

raw = _optional("DEVICE_HOST")
if not raw:
    raise SystemExit(
        "В .env нет DEVICE_HOST.\n"
        "На домашнем компьютере рядом с регистратором выполните ./tunnel.sh\n"
        "В строке Forwarding будет адрес вида tcp://0.tcp.ngrok.io:12345.\n"
        "В .env ноутбука запишите его без схемы:\n"
        "DEVICE_HOST=0.tcp.ngrok.io:12345\n"
        "После этого снова ./start.sh — go2rtc откроет DVRIP по этому хосту и порту."
    )

host, port = _parse_host(raw)
port = port or 34567
print(f"go2rtc подключится к DVRIP {host}:{port}")
print("Локальный поток: rtsp://127.0.0.1:8554/cam")
print("Страница: http://127.0.0.1:5001/")
PY

export PATH="$ROOT/bin:$PATH"
exec python3 "$ROOT/rtsp_server.py"
