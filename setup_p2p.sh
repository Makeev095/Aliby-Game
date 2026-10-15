#!/bin/bash
# Ставит официальный go2rtc с GitHub AlexxIT/go2rtc под этот Mac.
# Отдельного доверенного бинарника p2p-client / xm-p2p-client для облака
# XMEye нет: go2rtc открывает DVRIP по адресу DEVICE_HOST:34567.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$ROOT/bin"
STAGE="$ROOT/.setup-tmp"
API="https://api.github.com/repos/AlexxIT/go2rtc/releases/latest"

case "$(uname -s)" in
  Darwin) ;;
  *) echo "Скрипт рассчитан на macOS." >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64) ASSET="go2rtc_mac_arm64.zip" ;;
  x86_64) ASSET="go2rtc_mac_amd64.zip" ;;
  *) echo "Неизвестная архитектура: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$BIN_DIR" "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

echo "Архитектура: $(uname -m), файл релиза: $ASSET"
META="$(python3 - "$ASSET" "$API" <<'PY'
import json, sys, urllib.request
asset, api = sys.argv[1], sys.argv[2]
with urllib.request.urlopen(api, timeout=30) as response:
    release = json.load(response)
for item in release["assets"]:
    if item["name"] == asset:
        digest = item.get("digest") or ""
        if not digest.startswith("sha256:"):
            sys.exit("У ассета нет sha256 в API GitHub")
        url = item["browser_download_url"]
        if not url.startswith("https://github.com/AlexxIT/go2rtc/releases/download/"):
            sys.exit("Неожиданный адрес загрузки")
        print(release["tag_name"])
        print(url)
        print(digest.split(":", 1)[1])
        break
else:
    sys.exit(f"В релизе нет {asset}")
PY
)"

TAG="$(printf '%s\n' "$META" | sed -n '1p')"
URL="$(printf '%s\n' "$META" | sed -n '2p')"
WANT="$(printf '%s\n' "$META" | sed -n '3p')"
ZIP="$STAGE/$ASSET"

echo "Скачиваю go2rtc $TAG"
curl -fL --retry 3 --retry-delay 2 -o "$ZIP" "$URL"

GOT="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
if [[ "$GOT" != "$WANT" ]]; then
  echo "Контрольная сумма не сошлась." >&2
  echo "ожидалось $WANT" >&2
  echo "получено  $GOT" >&2
  exit 1
fi
echo "sha256 совпала"

rm -rf "$STAGE/unpack"
mkdir -p "$STAGE/unpack"
unzip -q "$ZIP" -d "$STAGE/unpack"
FOUND="$(find "$STAGE/unpack" -type f -name go2rtc | head -n 1)"
if [[ -z "$FOUND" ]]; then
  echo "В архиве нет файла go2rtc" >&2
  exit 1
fi

install -m 755 "$FOUND" "$BIN_DIR/go2rtc"
xattr -d com.apple.quarantine "$BIN_DIR/go2rtc" 2>/dev/null || true

if ! file "$BIN_DIR/go2rtc" | grep -q "Mach-O"; then
  echo "Скачанный файл не является программой macOS" >&2
  exit 1
fi

CFG="$STAGE/check.yaml"
cat > "$CFG" <<'EOF'
api:
  listen: "127.0.0.1:1984"
rtsp:
  listen: "127.0.0.1:8554"
EOF

if lsof -nP -iTCP:1984 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Порт 1984 занят, проверку запуска пропускаю. Файл: $BIN_DIR/go2rtc"
  exit 0
fi

"$BIN_DIR/go2rtc" -config "$CFG" >"$STAGE/go2rtc.log" 2>&1 &
PID=$!
OK=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if curl -sf -o /dev/null "http://127.0.0.1:1984/api"; then
    OK=1
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

if [[ "$OK" != 1 ]]; then
  echo "go2rtc не ответил на http://127.0.0.1:1984/api" >&2
  cat "$STAGE/go2rtc.log" >&2 || true
  exit 1
fi

echo "Готово: $BIN_DIR/go2rtc ($TAG) запускается."
echo "Дальше одной командой: ./start.sh"
echo "В .env нужен DEVICE_HOST. Cloud ID go2rtc не принимает."
