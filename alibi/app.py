import secrets
import threading
import uuid
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request

from cases import CASE, LOCKED, PLACES, assign_roles

ROOT = Path(__file__).resolve().parent
app = Flask(__name__, template_folder=str(ROOT / "templates"), static_folder=str(ROOT / "static"))

LOCK = threading.Lock()
ROOMS = {}
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
MIN_PLAYERS = 3
MAX_PLAYERS = 6

PAGES = {
    "detektivnaya-igra-online": {
        "title": "Детективная игра онлайн с друзьями",
        "description": "Короткое дело на компанию в браузере: ссылка в чат, свои роли, одно голосование. Первое дело бесплатно.",
        "kicker": "Для компании на созвоне",
        "h1": "Детективная игра онлайн с друзьями",
        "lead": "Не нужно ставить приложение и собирать ведущего. Один человек открывает стол, остальные заходят по ссылке со своего телефона.",
        "paragraphs": [
            "Алиби длится около получаса. Вы в одном созвоне или за одним столом. На экране у каждого своя роль: что сказать вслух и какая строка остаётся только ему.",
            "В бесплатном деле «Тихий тост» из сейфа пропадает конверт. Окно закрыто изнутри, код знали все, кто остался в доме. В конце стол голосует, кто забрал деньги.",
            "Игра рассчитана на троих, четверых, пятерых или шестерых. Меньше трёх дело не собирается: без спора голосовать некому.",
        ],
    },
    "kvest-dlya-kompanii": {
        "title": "Квест для компании онлайн",
        "description": "Квест на один вечер без коробки и ведущего. Ссылка, роли, 25–40 минут и общее голосование.",
        "kicker": "Один вечер",
        "h1": "Квест для компании онлайн",
        "lead": "Если на большое расследование нет двух часов, стол можно открыть сразу. Первое дело уже лежит в колоде.",
        "paragraphs": [
            "Хозяин стола отправляет ссылку в общий чат. Друзья пишут, как их зовут, и садятся. Когда вас хотя бы трое, роли раздаются сами.",
            "Дальше вы говорите. Сайт не заменяет разговор: он держит общее дело и прячет чужие тайны. Свою карту целиком вслух не читают.",
            "Следующее дело будет одним платежом на всю компанию, не с каждого. Оплату подключим отдельно. Сейчас открыт первый квест.",
        ],
    },
    "igry-pohozhie-na-kod-goroda": {
        "title": "Игры, похожие на Код города",
        "description": "Короткий детектив для компании, если хочется дело на вечер, а не длинное расследование на карте города.",
        "kicker": "Рядом по настроению",
        "h1": "Если ищете игры, похожие на Код города",
        "lead": "Код города — длинное дело на карте, с локациями и большим вечером. Алиби стоит рядом для другого запроса: сесть и закончить за полчаса.",
        "paragraphs": [
            "Там команда детективов ходит по городу. Здесь вы сами люди за столом, и один из вас говорит неправду. Ссылка открывается на телефоне, ведущий не нужен.",
            "Первое дело бесплатное, чтобы компания дошла до голосования. Дальше — отдельные дела, один чек на всех.",
            "Это не продолжение Кода города и не их кабинет. Другое дело, другой стол, своя колода.",
        ],
    },
}


def _code():
    while True:
        value = "".join(secrets.choice(ALPHABET) for _ in range(4))
        if value not in ROOMS:
            return value


def _player(name, host=False):
    return {
        "id": uuid.uuid4().hex[:10],
        "token": secrets.token_urlsafe(18),
        "name": name.strip()[:24],
        "host": host,
        "role_id": None,
        "vote": None,
    }


def _role_map():
    return {role["id"]: role for role in CASE["roles"]}


def _room_or_404(code):
    room = ROOMS.get(code.upper())
    if not room:
        abort(404)
    return room


def _viewer(room):
    token = request.headers.get("X-Player-Token", "")
    for player in room["players"]:
        if token and secrets.compare_digest(player["token"], token):
            return player
    return None


def _public(room, viewer):
    roles = _role_map()
    seated = []
    for player in room["players"]:
        role = roles.get(player["role_id"]) if room["phase"] != "lobby" else None
        seated.append(
            {
                "id": player["id"],
                "name": player["name"],
                "host": player["host"],
                "voted": player["vote"] is not None,
                "role": None
                if role is None
                else {"id": role["id"], "name": role["name"], "relation": role["relation"]},
            }
        )
    you = None
    if viewer:
        role = roles.get(viewer["role_id"])
        you = {
            "id": viewer["id"],
            "name": viewer["name"],
            "host": viewer["host"],
            "vote": viewer["vote"],
            "role": None
            if role is None
            else {
                "id": role["id"],
                "name": role["name"],
                "relation": role["relation"],
                "say": role["say"],
                "secret": role["secret"],
                "thief": False,
            },
        }
    reveal = None
    if room["phase"] == "reveal":
        thief = next(player for player in room["players"] if roles[player["role_id"]]["thief"])
        reveal = {
            "thief_id": thief["id"],
            "thief_name": thief["name"],
            "thief_role": roles[thief["role_id"]]["name"],
            "chain": [
                "Марк сказал, что был в ванной.",
                "Нина всё это время была в ванной одна.",
                "Лена видела Марка у двери кабинета.",
                "Конверт лежал во внутреннем кармане его пальто.",
            ],
            "cards": [
                {
                    "player_id": player["id"],
                    "player_name": player["name"],
                    "role": roles[player["role_id"]]["name"],
                    "say": roles[player["role_id"]]["say"],
                    "thief": roles[player["role_id"]]["thief"],
                    "vote": next(
                        (
                            roles[other["role_id"]]["name"]
                            for other in room["players"]
                            if other["id"] == player["vote"]
                        ),
                        None,
                    ),
                }
                for player in room["players"]
            ],
        }
    return {
        "code": room["code"],
        "phase": room["phase"],
        "case": {
            "number": CASE["number"],
            "title": CASE["title"],
            "place": CASE["place"],
            "brief": CASE["brief"],
            "timeline": CASE["timeline"],
        },
        "players": seated,
        "you": you,
        "need": MIN_PLAYERS,
        "max": MAX_PLAYERS,
        "places": [
            {
                "id": place["id"],
                "name": place["name"],
                "clue": place["clue"] if place["id"] in room["opened"] else None,
            }
            for place in PLACES
        ],
        "reveal": reveal,
    }


@app.get("/")
def home():
    return render_template("index.html", case=CASE, locked=LOCKED)


@app.get("/play/<code>")
def play(code):
    return render_template("play.html", code=code.upper(), case=CASE)


@app.get("/<slug>")
def seo(slug):
    page = PAGES.get(slug)
    if not page:
        abort(404)
    return render_template("article.html", page=page, case=CASE)


@app.post("/api/rooms")
def create_room():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    if len(name) < 2:
        return jsonify({"error": "Введите имя, хотя бы две буквы."}), 400
    with LOCK:
        code = _code()
        host = _player(name, host=True)
        ROOMS[code] = {"code": code, "phase": "lobby", "players": [host], "opened": []}
    return jsonify({"code": code, "token": host["token"], "player_id": host["id"]})


@app.post("/api/rooms/<code>/join")
def join_room(code):
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    if len(name) < 2:
        return jsonify({"error": "Введите имя, хотя бы две буквы."}), 400
    with LOCK:
        room = _room_or_404(code)
        if room["phase"] != "lobby":
            return jsonify({"error": "Стол уже в игре. Этот код закрыт."}), 409
        if len(room["players"]) >= MAX_PLAYERS:
            return jsonify({"error": "За столом уже шестеро."}), 409
        player = _player(name, host=False)
        room["players"].append(player)
    return jsonify({"code": room["code"], "token": player["token"], "player_id": player["id"]})


@app.get("/api/rooms/<code>")
def room_state(code):
    with LOCK:
        room = _room_or_404(code)
        viewer = _viewer(room)
        if viewer is None:
            return jsonify({"error": "Сначала сядьте за стол."}), 401
        return jsonify(_public(room, viewer))


@app.post("/api/rooms/<code>/start")
def start_room(code):
    with LOCK:
        room = _room_or_404(code)
        viewer = _viewer(room)
        if viewer is None or not viewer["host"]:
            return jsonify({"error": "Раздать роли может только тот, кто открыл стол."}), 403
        if room["phase"] != "lobby":
            return jsonify({"error": "Роли уже розданы."}), 409
        if len(room["players"]) < MIN_PLAYERS:
            return jsonify({"error": "Нужны минимум трое."}), 409
        roles = assign_roles(len(room["players"]))
        order = room["players"][:]
        secrets.SystemRandom().shuffle(order)
        for player, role in zip(order, roles):
            player["role_id"] = role["id"]
            player["vote"] = None
        room["phase"] = "play"
        return jsonify(_public(room, viewer))


@app.post("/api/rooms/<code>/look")
def look(code):
    payload = request.get_json(silent=True) or {}
    place_id = str(payload.get("place", ""))
    known = {place["id"] for place in PLACES}
    with LOCK:
        room = _room_or_404(code)
        viewer = _viewer(room)
        if viewer is None:
            return jsonify({"error": "Сначала сядьте за стол."}), 401
        if room["phase"] == "lobby":
            return jsonify({"error": "Сначала раздайте роли."}), 409
        if place_id not in known:
            return jsonify({"error": "Такой комнаты в доме нет."}), 404
        if place_id not in room["opened"]:
            room["opened"].append(place_id)
        return jsonify(_public(room, viewer))


@app.post("/api/rooms/<code>/vote")
def vote(code):
    payload = request.get_json(silent=True) or {}
    suspect = str(payload.get("player_id", ""))
    with LOCK:
        room = _room_or_404(code)
        viewer = _viewer(room)
        if viewer is None:
            return jsonify({"error": "Сначала сядьте за стол."}), 401
        if room["phase"] not in {"play", "vote"}:
            return jsonify({"error": "Голосование уже закрыто."}), 409
        if suspect == viewer["id"]:
            return jsonify({"error": "Себя выбрать нельзя."}), 400
        if not any(player["id"] == suspect for player in room["players"]):
            return jsonify({"error": "Этого человека нет за столом."}), 404
        viewer["vote"] = suspect
        room["phase"] = "vote"
        if all(player["vote"] for player in room["players"]):
            room["phase"] = "reveal"
        return jsonify(_public(room, viewer))


@app.errorhandler(404)
def missing(_error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Стол не найден."}), 404
    return render_template("article.html", page={
        "title": "Страница не найдена",
        "description": "Такой страницы в Алиби нет.",
        "kicker": "404",
        "h1": "Этой страницы нет",
        "lead": "Стол по этому адресу не открывался.",
        "paragraphs": ["Вернитесь на главную и откройте новое дело."],
    }, case=CASE), 404


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5055, debug=False, threaded=True)
