"""Локальный клиент регистратора: серийный номер, логин и пароль.

Адрес необязателен, если регистратор в той же сети, что и этот компьютер.
Клиент опрашивает только свою частную подсеть /24, входит указанным паролем
и оставляет устройство лишь когда серийный номер совпал. Чужие ответы
не сохраняются и не показываются.

Из другой сети укажите адрес туннеля (его печатает ./tunnel.sh). После входа
серийный номер сверяется так же.

Картинка — это H264-поток камеры (OPMonitor), без перекодирования в JPEG.

Запуск:
    python3 -m venv .venv
    .venv/bin/pip install flask python-dotenv
    .venv/bin/pip install "git+https://github.com/alexshpilkin/dvrip.git"
    .venv/bin/python vms_app.py
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import socket
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, Response, abort, jsonify, render_template, request

from camera_link import CameraError, CameraLink, LoginRejected, discover, encode_h264

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

log = logging.getLogger("vms")

HOST = "127.0.0.1"
PORT = 5002
DATA_PATH = ROOT / "data" / "devices.json"
DVR_PORT = 34567
MAX_DEVICES = 20
SCAN_DEADLINE_SEC = 20
PORT_TIMEOUT_SEC = 0.35

app = Flask(__name__)
_store_lock = threading.Lock()
_sessions_lock = threading.Lock()
_sessions: dict[str, "Session"] = {}


def _optional(name: str) -> str:
    return os.environ.get(name, "").strip()


def _parse_host(raw: str) -> tuple[str, int]:
    value = raw.strip()
    if "://" in value or "@" in value or "/" in value or " " in value:
        raise ValueError("Адрес укажите как host или host:port, без схемы и логина")
    if value.startswith("["):
        raise ValueError("IPv6 в адресе пока не поддерживается")
    if value.count(":") > 1:
        raise ValueError("Адрес укажите как host или host:port")
    if value.count(":") == 1:
        host, port_text = value.rsplit(":", 1)
        if not port_text.isdigit() or not (1 <= int(port_text) <= 65535):
            raise ValueError("Порт в адресе должен быть числом от 1 до 65535")
        port = int(port_text)
    else:
        host, port = value, DVR_PORT
    if not host or len(host) > 253:
        raise ValueError("Некорректный адрес")
    return host, port


def _normalize_serial(raw: str) -> str:
    serial = "".join(raw.split()).replace("-", "").lower()
    if not 8 <= len(serial) <= 32 or any(ch not in "0123456789abcdef" for ch in serial):
        raise ValueError("Серийный номер — это 8–32 шестнадцатеричных символа с наклейки или из меню Info → Version")
    return serial


def _read_store() -> list[dict]:
    if not DATA_PATH.is_file():
        return []
    try:
        payload = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        log.warning("Файл устройств повреждён, список пуст")
        return []
    if not isinstance(payload, list):
        return []
    return [item for item in payload if isinstance(item, dict)]


def _write_store(items: list[dict]) -> None:
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = DATA_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(DATA_PATH)
    os.chmod(DATA_PATH, 0o600)


def _env_device() -> dict | None:
    serial_raw = _optional("CLOUD_ID")
    user = _optional("USER") or _optional("DEVICE_USER")
    if "PASSWORD" in os.environ:
        password = os.environ.get("PASSWORD", "")
    elif "DEVICE_PASSWORD" in os.environ:
        password = os.environ.get("DEVICE_PASSWORD", "")
    else:
        password = None
    if not serial_raw or not user or password is None:
        return None
    try:
        serial = _normalize_serial(serial_raw)
    except ValueError:
        return None
    host = _optional("DEVICE_HOST")
    return {
        "id": "env",
        "name": "Регистратор",
        "serial": serial,
        "user": user,
        "password": password,
        "host": host,
        "source": "env",
    }


def _saved_devices() -> list[dict]:
    with _store_lock:
        items = _read_store()
    for item in items:
        item["source"] = "saved"
    return items


def _all_devices() -> list[dict]:
    devices = _saved_devices()
    env_device = _env_device()
    if env_device is not None:
        devices.insert(0, env_device)
    return devices


def _device_by_id(device_id: str) -> dict | None:
    for device in _all_devices():
        if device.get("id") == device_id:
            return device
    return None


def _public_device(device: dict, session: "Session | None") -> dict:
    host = device.get("host") or ""
    return {
        "id": device["id"],
        "name": device.get("name") or "Регистратор",
        "serial": device.get("serial") or "",
        "user": device.get("user") or "",
        "host": host,
        "source": device.get("source") or "saved",
        "online": bool(session and session.online),
        "error": "" if session is None else session.error,
        "channels": [] if session is None else session.channels,
        "info": {} if session is None else session.info,
    }


def _local_private_hosts() -> list[str]:
    addresses: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addresses.add(info[4][0])
    except socket.gaierror:
        pass
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))
        addresses.add(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        probe.close()

    hosts: list[str] = []
    seen: set[str] = set()
    for raw in addresses:
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            continue
        if not ip.is_private or ip.is_loopback or ip.is_link_local:
            continue
        network = ipaddress.ip_network(f"{raw}/24", strict=False)
        for host in network.hosts():
            text = str(host)
            if text == raw or text in seen:
                continue
            seen.add(text)
            hosts.append(text)
            if len(hosts) >= 512:
                return hosts
    return hosts


def _port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=PORT_TIMEOUT_SEC):
            return True
    except OSError:
        return False


def _login(host: str, port: int, user: str, password: str) -> CameraLink | None:
    try:
        return CameraLink.open(host, port, user, password)
    except LoginRejected:
        return None
    except (CameraError, OSError, TimeoutError):
        return None


class DeviceError(Exception):
    pass


def _find_on_lan(serial: str, user: str, password: str):
    hosts = _local_private_hosts()
    if not hosts:
        return None, None
    stop = threading.Event()
    found: dict[str, object] = {}
    found_lock = threading.Lock()
    deadline = time.monotonic() + SCAN_DEADLINE_SEC

    def attempt(host: str):
        if stop.is_set() or time.monotonic() > deadline:
            return
        try:
            if not _port_open(host, DVR_PORT):
                return
            if stop.is_set():
                return
            link = _login(host, DVR_PORT, user, password)
        except Exception:
            log.warning("Адрес в локальной сети не открылся")
            return
        if link is None:
            return
        if link.serial != serial:
            link.close()
            return
        with found_lock:
            if found.get("link") is not None:
                link.close()
                return
            found["host"] = host
            found["link"] = link
        stop.set()

    with ThreadPoolExecutor(max_workers=40) as pool:
        futures = [pool.submit(attempt, host) for host in hosts]
        for future in as_completed(futures):
            future.result()
            if stop.is_set():
                break
    link = found.get("link")
    host = found.get("host")
    if link is None or not isinstance(host, str):
        return None, None
    return host, link


def _find_by_discovery(serial: str, user: str, password: str):
    try:
        replies = discover(2.0)
    except OSError:
        return None, None
    for item in replies:
        announced = "".join(str(item.serial).split()).replace("-", "").lower()
        if announced != serial:
            continue
        port = item.tcpport or DVR_PORT
        link = _login(item.host, port, user, password)
        if link is None:
            continue
        if link.serial != serial:
            link.close()
            continue
        return f"{item.host}:{port}", link
    return None, None


class Session:
    def __init__(self, device: dict):
        self.device_id = device["id"]
        self._lock = threading.Lock()
        self.link: CameraLink | None = None
        self.host = device.get("host") or ""
        self.online = False
        self.error = ""
        self.channels: list[dict] = []
        self.info: dict = {}

    def connect(self, device: dict) -> None:
        with self._lock:
            self._close_unlocked()
            self.error = ""
            try:
                host, link = self._open(device)
            except DeviceError as exc:
                self.online = False
                self.error = str(exc)
                return
            except ImportError:
                self.online = False
                self.error = "Не установлена библиотека dvrip."
                return
            except Exception as exc:
                log.warning("Вход не выполнен: %s", exc.__class__.__name__)
                self.online = False
                self.error = "Регистратор не ответил. Проверьте пароль, сеть и серийный номер."
                return
            if link is None or host is None:
                self.online = False
                self.error = "Регистратор с таким серийным номером не ответил."
                return
            try:
                count = link.channel_count()
                flags = link.channel_online(count)
                info = link.details()
            except Exception:
                link.close()
                self.online = False
                self.error = "Вход выполнен, но данные каналов не прочитались."
                return
            self.link = link
            self.host = host
            self.online = True
            self.info = info
            self.channels = [
                {"index": index, "name": f"Канал {index + 1}", "online": flags[index]}
                for index in range(count)
            ]

    def _open(self, device: dict):
        user = device["user"]
        password = device.get("password") or ""
        serial = device["serial"]
        raw_host = (device.get("host") or "").strip()
        if raw_host:
            host, port = _parse_host(raw_host)
            link = _login(host, port, user, password)
            if link is None:
                raise DeviceError("Регистратор не принял логин или пароль по указанному адресу.")
            if link.serial != serial:
                link.close()
                raise DeviceError("По этому адресу ответил регистратор с другим серийным номером.")
            return f"{host}:{port}", link
        host, link = _find_by_discovery(serial, user, password)
        if link is None or host is None:
            host, link = _find_on_lan(serial, user, password)
        if link is None or host is None:
            raise DeviceError(
                "В этой сети регистратор с таким серийным номером не ответил. "
                "Если смотрите не из дома, укажите адрес туннеля."
            )
        return host, link

    def frames(self, channel: int):
        with self._lock:
            link = self.link
            if link is None or not self.online:
                return
        try:
            yield from encode_h264(link.frames(channel))
        except Exception:
            log.warning("Поток H264 прервался")
            with self._lock:
                if self.link is link:
                    self._close_unlocked()
                    self.error = "Поток прервался. Откройте устройство ещё раз."

    def nudge(self, channel: int, command: str) -> None:
        with self._lock:
            link = self.link
            if link is None or not self.online:
                raise ConnectionError("Устройство не открыто")
        link.nudge(channel, command)

    def close(self) -> None:
        with self._lock:
            self._close_unlocked()

    def _close_unlocked(self) -> None:
        link = self.link
        self.link = None
        self.online = False
        self.channels = []
        self.info = {}
        if link is not None:
            try:
                link.close()
            except Exception:
                pass


def _session_for(device_id: str) -> Session | None:
    with _sessions_lock:
        return _sessions.get(device_id)


def _open_session(device: dict) -> Session:
    with _sessions_lock:
        session = _sessions.get(device["id"])
        if session is None:
            session = Session(device)
            _sessions[device["id"]] = session
    session.connect(device)
    return session


@app.get("/")
def index():
    return render_template("vms.html")


@app.get("/api/devices")
def list_devices():
    rows = []
    for device in _all_devices():
        rows.append(_public_device(device, _session_for(device["id"])))
    return jsonify(rows)


@app.post("/api/devices")
def add_device():
    payload = request.get_json(silent=True) or {}
    try:
        serial = _normalize_serial(str(payload.get("serial") or ""))
        user = str(payload.get("user") or "").strip()
        password = str(payload.get("password") or "")
        name = str(payload.get("name") or "").strip() or "Регистратор"
        host = str(payload.get("host") or "").strip()
        if not user or len(user) > 32:
            raise ValueError("Укажите имя пользователя регистратора")
        if len(password) > 64:
            raise ValueError("Пароль слишком длинный")
        if len(name) > 40:
            raise ValueError("Имя устройства слишком длинное")
        if host:
            _parse_host(host)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    with _store_lock:
        items = _read_store()
        if len(items) >= MAX_DEVICES:
            return jsonify({"error": "Можно сохранить не больше 20 устройств"}), 400
        device = {
            "id": uuid.uuid4().hex,
            "name": name,
            "serial": serial,
            "user": user,
            "password": password,
            "host": host,
        }
        items.append(device)
        _write_store(items)
    return jsonify(_public_device(device, None)), 201


@app.delete("/api/devices/<device_id>")
def delete_device(device_id: str):
    if device_id == "env":
        return jsonify({"error": "Устройство из .env убирается правкой файла .env"}), 400
    session = _session_for(device_id)
    if session is not None:
        session.close()
        with _sessions_lock:
            _sessions.pop(device_id, None)
    with _store_lock:
        items = [item for item in _read_store() if item.get("id") != device_id]
        _write_store(items)
    return jsonify({"ok": True})


@app.post("/api/devices/<device_id>/open")
def open_device(device_id: str):
    device = _device_by_id(device_id)
    if device is None:
        abort(404)
    session = _open_session(device)
    body = _public_device(device, session)
    if not session.online:
        return jsonify(body), 502
    return jsonify(body)


@app.post("/api/devices/<device_id>/ptz")
def ptz(device_id: str):
    device = _device_by_id(device_id)
    session = _session_for(device_id)
    if device is None or session is None or not session.online:
        return jsonify({"error": "Сначала откройте устройство"}), 409
    payload = request.get_json(silent=True) or {}
    try:
        channel = int(payload.get("channel", 0))
        command = str(payload.get("command") or "")
    except (TypeError, ValueError):
        return jsonify({"error": "Некорректный канал"}), 400
    if channel < 0 or channel >= max(len(session.channels), 1):
        return jsonify({"error": "Нет такого канала"}), 400
    try:
        session.nudge(channel, command)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except ConnectionError as exc:
        return jsonify({"error": str(exc)}), 409
    except Exception:
        log.warning("Команда поворота не выполнилась")
        return jsonify({"error": "Регистратор не принял команду поворота"}), 502
    return jsonify({"ok": True})


@app.get("/stream/<device_id>/<int:channel>")
def stream(device_id: str, channel: int):
    session = _session_for(device_id)
    if session is None or not session.online:
        return Response("Сначала откройте устройство", status=409, content_type="text/plain; charset=utf-8")
    if channel < 0 or channel >= max(len(session.channels), 1):
        abort(404)
    return Response(
        session.frames(channel),
        mimetype="application/octet-stream",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    app.run(host=HOST, port=PORT, threaded=True)
