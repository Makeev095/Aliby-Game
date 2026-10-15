#!/bin/bash
# Запускать на домашнем компьютере, который в одной сети с регистратором.
# Публикует TCP 192.168.1.253:34567 через ngrok и печатает строку для .env ноутбука.
#
# ngrok tcp 34567 открывает порт этого компьютера.
# Регистратор слушает другой адрес, поэтому цель туннеля — 192.168.1.253:34567.
set -euo pipefail

ADDR="${1:-192.168.1.253:34567}"

if ! command -v ngrok >/dev/null 2>&1; then
  echo "На этом компьютере нет ngrok." >&2
  echo "Установка: brew install ngrok" >&2
  echo "Токен один раз, его не кладут в проект: ngrok config add-authtoken <токен>" >&2
  echo "Токен берётся в кабинете: https://dashboard.ngrok.com/get-started/your-authtoken" >&2
  exit 1
fi

echo "Туннель: ngrok tcp ${ADDR}"
echo "После старта в .env ноутбука нужна строка DEVICE_HOST=хост:порт без tcp://"
echo

ngrok tcp "$ADDR" >/tmp/ngrok-recorder.log 2>&1 &
NGROK_PID=$!
cleanup() {
  kill "$NGROK_PID" 2>/dev/null || true
  wait "$NGROK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

python3 - "$NGROK_PID" <<'PY' &
import json, sys, time, urllib.request
pid = int(sys.argv[1])
deadline = time.time() + 20
while time.time() < deadline:
    try:
        with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=1) as response:
            payload = json.load(response)
    except Exception:
        time.sleep(0.4)
        continue
    for tunnel in payload.get("tunnels", []):
        public = tunnel.get("public_url", "")
        if public.startswith("tcp://"):
            hostport = public[len("tcp://"):]
            print()
            print("Скопируйте на ноутбук в файл .env ровно эту строку:")
            print(f"DEVICE_HOST={hostport}")
            print()
            print("Пример того, как выглядит адрес: 0.tcp.ngrok.io:12345")
            print("Префикс tcp:// в .env не нужен. После каждого перезапуска ngrok порт меняется.")
            print("На ноутбуке затем: ./start.sh")
            print("Остановить туннель: Ctrl+C")
            sys.exit(0)
    time.sleep(0.4)
print("ngrok не выдал публичный адрес. Смотрите /tmp/ngrok-recorder.log", file=sys.stderr)
sys.exit(1)
PY
WATCH_PID=$!

wait "$NGROK_PID"
status=$?
kill "$WATCH_PID" 2>/dev/null || true
if [[ "$status" -ne 0 ]]; then
  echo "ngrok завершился с кодом $status. Последние строки лога:" >&2
  tail -n 30 /tmp/ngrok-recorder.log >&2 || true
  exit "$status"
fi
