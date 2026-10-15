"""Подключение к регистратору Xiongmai по протоколу DVRIP.

Библиотека: https://github.com/alexshpilkin/dvrip
Видео остаётся потоком H264, который камера отдаёт командой OPMonitor.
"""

from __future__ import annotations

import logging
import socket
import struct
import threading
from collections.abc import Iterator
from socket import AF_INET, SOCK_STREAM
from socket import socket as Socket

from dvrip import DVRIP_PORT
from dvrip.errors import DVRIPDecodeError, DVRIPRequestError
from dvrip.io import DVRIPClient
from dvrip.message import Request, Session
from dvrip.monitor import Stream
import dvrip.packet as _packet
from dvrip.ptz import PTZButton, DoPTZReply
from dvrip.typing import Object, fixedmember, member

def _read_or_stop(file, length: int) -> bytearray:
    """Чтение пакета. Пустой ответ — конец потока, а не вечный цикл."""
    data = bytearray(length)
    view = memoryview(data)
    while view:
        got = file.readinto(view)
        if not got:
            raise ConnectionError("Регистратор закрыл поток")
        view = view[got:]
    return data


_packet._read = _read_or_stop

log = logging.getLogger("vms")

_MAX_FRAME = 8_000_000
_PTZ = {
    "up": PTZButton.UP,
    "down": PTZButton.DOWN,
    "left": PTZButton.LEFT,
    "right": PTZButton.RIGHT,
    "zoom_in": PTZButton.IN,
    "zoom_out": PTZButton.OUT,
}


class CameraError(Exception):
    pass


class LoginRejected(CameraError):
    pass


class _NudgeParams(Object):
    _aux: fixedmember = fixedmember("AUX", {"Number": 0, "Status": "On"})
    channel: member[int] = member("Channel")
    _menu: fixedmember = fixedmember("MenuOpts", "Enter")
    _point: fixedmember = fixedmember("POINT", {"bottom": 0, "left": 0, "right": 0, "top": 0})
    _pattern: fixedmember = fixedmember("Pattern", "SetBegin")
    preset: member[int] = member("Preset")
    _step: fixedmember = fixedmember("Step", 5)
    _tour: fixedmember = fixedmember("Tour", 0)


class _Nudge(Object):
    button: member[PTZButton] = member("Command")
    params: member[_NudgeParams] = member("Parameter")


class _DoNudge(Object, Request):
    type = 1400
    reply = DoPTZReply

    session: member[Session] = member("SessionID")
    command: fixedmember = fixedmember("Name", "OPPTZControl")
    ptz: member[_Nudge] = member("OPPTZControl")


def _normalize_serial(raw: str) -> str:
    return "".join(str(raw).split()).replace("-", "").lower()


class CameraLink:
    """Одна сессия DVRIP: вход, сведения о каналах, H264 и короткий шаг PTZ."""

    def __init__(self, client: DVRIPClient, host: str, port: int):
        self.client = client
        self.host = host
        self.port = port
        self.system = client.systeminfo()
        self.serial = _normalize_serial(self.system.serial)
        self._lock = threading.Lock()
        self._closed = threading.Event()
        self._media: list[Socket] = []
        self._keeper = threading.Thread(target=self._keep_alive, name="dvrip-keepalive", daemon=True)
        self._keeper.start()

    @classmethod
    def open(cls, host: str, port: int, user: str, password: str) -> "CameraLink":
        sock = Socket(AF_INET, SOCK_STREAM)
        sock.settimeout(10)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        client = DVRIPClient(sock)
        try:
            client.connect((host, port), user, password or "")
        except DVRIPRequestError as exc:
            sock.close()
            if exc.code in {106, 203, 204}:
                raise LoginRejected("Регистратор не принял логин или пароль.") from exc
            raise CameraError("Регистратор отклонил вход.") from exc
        except OSError:
            sock.close()
            raise
        try:
            return cls(client, host, port)
        except Exception:
            try:
                client.logout()
            except Exception:
                pass
            sock.close()
            raise

    def close(self) -> None:
        self._closed.set()
        with self._lock:
            for media in list(self._media):
                try:
                    media.close()
                except OSError:
                    pass
            self._media.clear()
            try:
                if self.client.session is not None:
                    self.client.logout()
            except Exception:
                pass
            try:
                self.client.socket.close()
            except OSError:
                pass

    def channel_count(self) -> int:
        digital = self.system._digitalin
        if digital is NotImplemented:
            digital = 0
        count = int(self.system.videoin or 0) + int(digital or 0)
        if count <= 0:
            count = 1
        return max(1, min(count, 32))

    def channel_online(self, count: int) -> list[bool]:
        flags = [True] * count
        try:
            with self._lock:
                activity = self.client.activityinfo()
        except (DVRIPDecodeError, DVRIPRequestError, OSError):
            return flags
        for index, channel in enumerate(activity.channels[:count]):
            flags[index] = bool(channel.recording or channel.bitrate)
        return flags

    def details(self) -> dict:
        runtime = ""
        minutes = int(self.system.uptime or 0)
        if minutes:
            runtime = f"{minutes // 60} ч {minutes % 60} мин"
        model = self.system.board
        if model is NotImplemented or not model:
            model = self.system.hardware or ""
        software = self.system.software or ""
        return {
            "model": str(model or ""),
            "software": str(software or ""),
            "runtime": runtime,
        }

    def nudge(self, channel: int, command: str) -> None:
        button = _PTZ.get(command)
        if button is None:
            raise ValueError("Неизвестная команда поворота")
        start = _DoNudge(
            session=self.client.session,
            ptz=_Nudge(button=button, params=_NudgeParams(channel=channel, preset=65535)),
        )
        stop = _DoNudge(
            session=self.client.session,
            ptz=_Nudge(button=button, params=_NudgeParams(channel=channel, preset=-1)),
        )
        with self._lock:
            if self._closed.is_set() or self.client.session is None:
                raise ConnectionError("Устройство не открыто")
            self.client.request(start)
            self.client.request(stop)

    def frames(self, channel: int, *, stream: Stream = Stream.HD) -> Iterator[tuple[bool, bytes]]:
        """Кадры H264: (ключевой, байты Annex-B)."""
        media = Socket(AF_INET, SOCK_STREAM)
        media.settimeout(20)
        media.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        try:
            media.connect((self.host, self.port))
        except OSError:
            media.close()
            raise
        with self._lock:
            self._media.append(media)
            if self._closed.is_set() or self.client.session is None:
                self._drop_media(media)
                raise ConnectionError("Устройство не открыто")
            try:
                reader = self.client.monitor(media, channel, stream)
            except Exception:
                self._drop_media(media)
                raise
        try:
            yield from iter_h264(reader)
        finally:
            with self._lock:
                self._drop_media(media)

    def _drop_media(self, media: Socket) -> None:
        try:
            self._media.remove(media)
        except ValueError:
            pass
        try:
            media.close()
        except OSError:
            pass

    def _keep_alive(self) -> None:
        while not self._closed.wait(5):
            try:
                with self._lock:
                    if self._closed.is_set() or self.client.session is None:
                        return
                    self.client.keepalive()
            except Exception:
                log.warning("Сессия регистратора оборвалась")
                return


def discover(timeout: float = 2.0) -> list:
    """Регистраторы, которые ответили на широковещательный поиск DVRIP."""
    found = []
    seen: set[str] = set()
    try:
        replies = list(DVRIPClient.discover("", timeout))
    except OSError:
        return found
    for item in replies:
        if item.host in seen:
            continue
        seen.add(item.host)
        found.append(item)
    return found


def iter_h264(reader) -> Iterator[tuple[bool, bytes]]:
    """Собирает кадры из медиапакетов DVRIP и оставляет только H264."""
    pending = bytearray()
    codec_h264 = False

    def fill(size: int) -> bool:
        while len(pending) < size:
            chunk = reader.read(65536)
            if not chunk:
                return False
            pending.extend(chunk)
        return True

    while True:
        if not fill(8):
            return
        kind = struct.unpack_from(">I", pending, 0)[0]
        if kind in {0x1FC, 0x1FE}:
            if not fill(16):
                return
            media, _fps, _w, _h, _dt, length = struct.unpack_from("<BBBBII", pending, 4)
            header = 16
            is_key = True
            if kind == 0x1FC:
                codec_h264 = media == 2
                video = codec_h264
            else:
                video = False
        elif kind == 0x1FD:
            header = 8
            length = struct.unpack_from("<I", pending, 4)[0]
            is_key = False
            video = codec_h264
        elif kind in {0x1FA, 0x1F9}:
            header = 8
            length = struct.unpack_from("<H", pending, 6)[0]
            is_key = False
            video = False
        else:
            del pending[:1]
            continue
        if length < 0 or length > _MAX_FRAME:
            del pending[:1]
            continue
        total = header + length
        if not fill(total):
            return
        payload = bytes(pending[header:total])
        del pending[:total]
        if not video or not payload:
            continue
        if not payload.startswith((b"\x00\x00\x00\x01", b"\x00\x00\x01")):
            payload = b"\x00\x00\x00\x01" + payload
        yield is_key, payload


def encode_h264(frames: Iterator[tuple[bool, bytes]]) -> Iterator[bytes]:
    """Длина кадра и признак ключевого кадра, затем байты H264."""
    for key, payload in frames:
        yield struct.pack(">BI", 1 if key else 0, len(payload)) + payload


__all__ = (
    "DVRIP_PORT",
    "CameraError",
    "CameraLink",
    "LoginRejected",
    "Stream",
    "discover",
    "encode_h264",
    "iter_h264",
)
