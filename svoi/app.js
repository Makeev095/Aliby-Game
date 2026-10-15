const COLORS = {
  masha: "#e3a15d",
  lesha: "#7ea8a4",
  kira: "#d27d8a",
  timur: "#d2c07a",
};

const QUESTIONS = [
  { id: "night", label: "Кому из компании напишешь в три ночи?" },
  { id: "habit", label: "Мелкая привычка, о которой тут почти никто не знает" },
  { id: "loud", label: "Кто сегодня будет говорить больше всех?" },
];

function emptyActions() {
  return {
    seen: {},
    cake: {},
    jacketGuess: {},
    jacketHidden: null,
    toast: {},
    stay: {},
    kitchen: {},
    whisperTo: null,
  };
}

function fresh() {
  return {
    screen: "landing",
    beat: 0,
    openId: null,
    error: "",
    players: [
      {
        id: "masha",
        name: "Маша",
        answers: {
          night: "Тимуру",
          habit: "переписываю сообщения три раза, прежде чем отправить",
          loud: "Лёша",
        },
      },
      {
        id: "lesha",
        name: "Лёша",
        answers: {
          night: "Маше",
          habit: "считаю ступеньки, когда нервничаю",
          loud: "Маша",
        },
      },
      {
        id: "kira",
        name: "Кира",
        answers: {
          night: "Лёше",
          habit: "фотографирую еду и никогда не выкладываю",
          loud: "Тимур",
        },
      },
      {
        id: "timur",
        name: "Тимур",
        answers: {
          night: "Маше",
          habit: "оставляю свет в коридоре",
          loud: "Кира",
        },
      },
    ],
    actions: emptyActions(),
  };
}

let state = fresh();
let paintedScreen = null;
let paintedBeat = null;
let paintedOpen = null;

const app = document.querySelector("#app");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function nameOf(id) {
  const player = state.players.find((item) => item.id === id);
  const name = (player?.name || "").trim();
  return name || "Без имени";
}

function joinNames(names) {
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return `${names[0]} и ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} и ${names[names.length - 1]}`;
}

function clonePlayers() {
  return state.players.map((player) => ({
    id: player.id,
    name: player.name,
    answers: { ...player.answers },
  }));
}

function roleOf(id) {
  const masha = nameOf("masha");
  const lesha = nameOf("lesha");
  const roles = {
    masha: {
      title: "Организаторка",
      public: "Все знают: стол собрала ты.",
      secret: "Аня написала тебе вчера: «Не ждите, я уезжаю». Ты всё равно накрыла стол.",
      goal: "Чтобы компания осталась до конца.",
    },
    lesha: {
      title: "Коллега",
      public: "Для остальных ты коллега Ани. В этой квартире ты впервые.",
      secret: `Ты пришёл не к Ане. Тебе нужно было оказаться здесь из-за одного человека: ${masha}.`,
      goal: `Чтобы на кухне вы остались вдвоём: ты и ${masha}.`,
    },
    kira: {
      title: "Плюс один",
      public: `Ты пришла с ${lesha}. Этих людей видишь почти впервые.`,
      secret: `Вчера в лифте Аня сказала тебе: «Если ${lesha} спросит — меня сегодня не было».`,
      goal: "До финала шепнуть правду хотя бы одному за столом.",
    },
    timur: {
      title: "Друг детства",
      public: "Ты знаешь Аню дольше всех в комнате.",
      secret: "Вчера в 23:40 ты был здесь и помогал закрывать коробки. Куртка на стуле — твоя.",
      goal: "Убрать куртку, пока на неё не начали показывать.",
    },
  };
  return roles[id];
}

function toastLine(player) {
  const { night, habit, loud } = player.answers;
  if (player.id === "masha") return `В три ночи я напишу ${night}. И да, я ${habit}.`;
  if (player.id === "lesha") return `${cap(habit)}. В три ночи я напишу только ${night}.`;
  if (player.id === "kira") return `Я ${habit}. Больше всех сегодня, кажется, скажет ${loud}.`;
  return `Я ${habit}. Вчера тоже. В три ночи я бы написал ${night}.`;
}

function cap(text) {
  const value = (text || "").trim();
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function needs(player) {
  const actions = state.actions;
  switch (state.beat) {
    case 0:
      return !actions.seen[player.id];
    case 1:
      return !actions.cake[player.id];
    case 2:
      return player.id === "timur" ? actions.jacketHidden === null : !actions.jacketGuess[player.id];
    case 3:
      return !actions.toast[player.id];
    case 4:
      return !actions.stay[player.id];
    case 5:
      return !actions.kitchen[player.id];
    default:
      return false;
  }
}

function beatComplete() {
  return state.players.every((player) => !needs(player));
}

function answersReady() {
  return state.players.every((player) => {
    const answers = player.answers;
    return player.name.trim() && answers.night.trim() && answers.habit.trim() && answers.loud.trim();
  });
}

function guessChoices() {
  return [
    { id: "timur", label: `Похоже, это ${nameOf("timur")}` },
    { id: "lesha", label: `Кажется, это ${nameOf("lesha")}` },
    { id: "stranger", label: "Кто-то не из компании" },
    { id: "quiet", label: "Не скажу вслух" },
  ];
}

function choiceLabel(list, id) {
  return list.find((item) => item.id === id)?.label || "";
}

function scoreboard() {
  const actions = state.actions;
  const stayCount = state.players.filter((player) => actions.stay[player.id] === "stay").length;
  const kitchen = actions.kitchen;
  const named = state.players.filter((player) => actions.jacketGuess[player.id] === "timur").length;
  const hidden = actions.jacketHidden === true;

  let timur;
  if (hidden && named >= 1) timur = { win: true, line: "Его называют, но куртка уже в спальне." };
  else if (hidden) timur = { win: true, line: "Куртка исчезает до разговора." };
  else if (named >= 2) timur = { win: false, line: "Куртку узнают и оставляют на стуле." };
  else timur = { win: true, line: "Куртка на виду, но стол смотрит мимо." };

  let lesha;
  if (kitchen.lesha === "masha" && kitchen.masha === "lesha") {
    lesha = { win: true, line: "Они с организаторкой зовут друг друга на кухню." };
  } else if (kitchen.lesha !== "masha") {
    lesha = { win: false, line: "Сам зовёт на кухню не её." };
  } else {
    lesha = { win: false, line: "Зовёт её, но она выбирает другого." };
  }

  const kira = actions.whisperTo
    ? { win: true, line: `Шёпотом это слышит ${nameOf(actions.whisperTo)}.` }
    : { win: false, line: "Молчит про лифт до самого конца." };

  return [
    { id: "masha", win: stayCount >= 3, line: stayCount >= 3 ? "Компания остаётся до конца." : "Стол выбирает разойтись." },
    { id: "lesha", ...lesha },
    { id: "kira", ...kira },
    { id: "timur", ...timur },
  ].map((row) => ({ ...row, name: nameOf(row.id) }));
}

function scoreList() {
  return `<ul class="score">${scoreboard().map((row) => `
    <li class="${row.win ? "win" : "miss"}">
      <span>${esc(row.name)}</span>
      <b>${esc(row.line)}</b>
      <em>${row.win ? "вышло" : "мимо"}</em>
    </li>`).join("")}</ul>`;
}

function peopleList(pairs) {
  return `<ul class="choices">${pairs.map(([name, detail]) => `<li><b>${esc(name)}</b><span>${esc(detail)}</span></li>`).join("")}</ul>`;
}

function resultHTML() {
  if (!beatComplete() || state.beat === 6) return "";
  if (state.beat === 0) {
    return `<div class="result"><p>Все за столом. Секреты больше не на общем экране.</p></div>`;
  }
  if (state.beat === 1) {
    const labels = { cut: "Режем молча", wait: "Не трогаем, ждём Аню", ask: "Спросить, кто заказывал" };
    const values = state.players.map((player) => state.actions.cake[player.id]);
    const lead = values.every((value) => value === values[0]) ? "Здесь вы сходитесь." : "Здесь стол расходится.";
    const pairs = state.players.map((player) => [nameOf(player.id), labels[state.actions.cake[player.id]]]);
    return `<div class="result"><p>${lead}</p>${peopleList(pairs)}</div>`;
  }
  if (state.beat === 2) {
    const hidden = state.actions.jacketHidden === true;
    const lead = hidden ? "Пока идёт разговор, куртка со стула исчезает." : "Куртка остаётся на стуле.";
    const pairs = state.players
      .filter((player) => player.id !== "timur")
      .map((player) => [nameOf(player.id), choiceLabel(guessChoices(), state.actions.jacketGuess[player.id])]);
    return `<div class="result"><p>${lead}</p>${peopleList(pairs)}</div>`;
  }
  if (state.beat === 3) {
    const pairs = state.players.map((player) => [nameOf(player.id), `громкий сегодня — ${player.answers.loud.trim()}`]);
    return `<div class="result"><p>Четыре фразы сказаны вслух. В них были ваши ответы, не текст сценария.</p>${peopleList(pairs)}</div>`;
  }
  if (state.beat === 4) {
    const labels = { stay: "Остаётся", leave: "Уходит" };
    const stayCount = state.players.filter((player) => state.actions.stay[player.id] === "stay").length;
    let lead = "Стол делится.";
    if (stayCount === 4) lead = "Никто не встаёт. Вечер ещё держится.";
    if (stayCount === 0) lead = "Стулья отодвигаются. Все четверо за уход.";
    const pairs = state.players.map((player) => [nameOf(player.id), labels[state.actions.stay[player.id]]]);
    const whisper = state.actions.whisperTo ? "<p>Кто-то за столом уже слышал правду шёпотом.</p>" : "";
    return `<div class="result"><p>${lead}</p>${whisper}${peopleList(pairs)}</div>`;
  }
  const mutual = [];
  for (const player of state.players) {
    const otherId = state.actions.kitchen[player.id];
    if (otherId && state.actions.kitchen[otherId] === player.id && player.id < otherId) {
      mutual.push(`${nameOf(player.id)} и ${nameOf(otherId)}`);
    }
  }
  const lead = mutual.length ? `На кухне сходятся ${mutual.join(", ")}.` : "Взаимных пар нет. Торт режут без совпадения.";
  const pairs = state.players.map((player) => [nameOf(player.id), `→ ${nameOf(state.actions.kitchen[player.id])}`]);
  return `<div class="result"><p>${esc(lead)}</p>${peopleList(pairs)}</div>`;
}

function beatView() {
  const masha = nameOf("masha");
  const lesha = nameOf("lesha");
  const kira = nameOf("kira");
  const timur = nameOf("timur");
  const beats = [
    {
      kicker: "Прихожая",
      title: "Дверь просто толкните",
      body: "<p>Пятый этаж. Дверь не заперта. На столе четыре бокала и один лишний.</p>",
      ping: ["Аня", "Я уже почти дома. Начинайте без меня. Дверь просто толкните."],
    },
    {
      kicker: "Кухня",
      title: "На торте не имя",
      body: "<p>На кухне торт. Глазурь выводит не имя, а слово <em>пока</em>. Чек из кондитерской лежит рядом, получатель — Аня.</p>",
    },
    {
      kicker: "23:40",
      title: "Куртка ни на ком",
      body: "<p>Домофон помнит вчерашний вызов: дверь открыли из квартиры. На стуле куртка. Сейчас она ни на ком.</p>",
    },
    {
      kicker: "Тост",
      title: "Фраза уже в телефоне",
      body: `<p>${esc(masha)} поднимает бокал, чтобы заполнить паузу. Строку не выдумывают: она собрана из тихих ответов до вечера.</p>`,
    },
    {
      kicker: "Сообщение",
      title: "Не ждите",
      body: "<p>Это видят все. Решают по телефонам, не вслух: оставаться за этим столом или встать.</p>",
      ping: ["Аня", "Не ждите. Серьёзно. Я не шучу."],
    },
    {
      kicker: "Кухня",
      title: "Торт всё ещё целый",
      body: "<p>Один его не режет. В телефоне каждый зовёт с собой одного человека.</p>",
    },
    {
      kicker: "Финал",
      title: "Ночной поезд",
      body: `
        <p>Аня не стоит в пробке. Она садится на ночной поезд и к этому столу не вернётся. Квартира сдана с утра.</p>
        <p>Вчера ${esc(masha)} получила сообщение: «Собери их. Я не смогу сказать это сама». Слово на торте Аня выбрала сама.</p>
        <p>${esc(timur)} закрывал здесь коробки в 23:40. ${esc(kira)} узнала всё в лифте и обещала молчать. ${esc(lesha)} пришёл не к имениннице. Его причина за этим столом — ${esc(masha)}.</p>`,
    },
  ];
  return beats[state.beat];
}

function options(key, playerId, items) {
  const current = state.actions[key][playerId];
  return `<div class="opts">${items.map((item) => `
    <button type="button" class="opt${current === item.id ? " on" : ""}" data-act="pick" data-key="${key}" data-id="${playerId}" data-value="${item.id}">${esc(item.label)}</button>
  `).join("")}</div>`;
}

function taskHTML(player) {
  if (state.beat === 0) {
    return `<div class="task"><h4>Прочитай и оставь это у себя.</h4>
      <button type="button" class="opt${state.actions.seen[player.id] ? " on" : ""}" data-act="pick" data-key="seen" data-id="${player.id}" data-value="1">Секрет только мой</button></div>`;
  }
  if (state.beat === 1) {
    return `<div class="task"><h4>Что делаешь с тортом?</h4>${options("cake", player.id, [
      { id: "cut", label: "Режем молча" },
      { id: "wait", label: "Не трогаем, ждём Аню" },
      { id: "ask", label: "Спросить, кто это заказал" },
    ])}</div>`;
  }
  if (state.beat === 2 && player.id === "timur") {
    const hidden = state.actions.jacketHidden;
    return `<div class="task"><h4>Это твоя куртка. Все сейчас смотрят на торт.</h4>
      <button type="button" class="opt${hidden === true ? " on" : ""}" data-act="hide" data-value="1">Унести в спальню</button>
      <button type="button" class="opt${hidden === false ? " on" : ""}" data-act="hide" data-value="0">Оставить на стуле</button></div>`;
  }
  if (state.beat === 2) {
    return `<div class="task"><h4>Чья, по-твоему, куртка?</h4>${options("jacketGuess", player.id, guessChoices())}</div>`;
  }
  if (state.beat === 3) {
    return `<div class="task"><h4>Скажи это вслух.</h4><p class="quote">«${esc(toastLine(player))}»</p>
      <button type="button" class="opt${state.actions.toast[player.id] ? " on" : ""}" data-act="pick" data-key="toast" data-id="${player.id}" data-value="1">Говорю это за столом</button></div>`;
  }
  if (state.beat === 4) {
    return `<div class="task"><h4>Аня пишет: не ждите. Ты?</h4>${options("stay", player.id, [
      { id: "stay", label: "Остаюсь" },
      { id: "leave", label: "Встаю" },
    ])}</div>`;
  }
  if (state.beat === 5) {
    const others = state.players.filter((item) => item.id !== player.id).map((item) => ({ id: item.id, label: nameOf(item.id) }));
    return `<div class="task"><h4>Кого зовёшь на кухню?</h4>${options("kitchen", player.id, others)}</div>`;
  }
  return "";
}

function whisperHTML(player) {
  if (player.id !== "kira" || state.beat < 2 || state.beat > 5) return "";
  const current = state.actions.whisperTo;
  const buttons = state.players.filter((item) => item.id !== "kira").map((item) => `
    <button type="button" class="opt${current === item.id ? " on" : ""}" data-act="whisper" data-id="${item.id}">Шепнуть: ${esc(nameOf(item.id))}</button>
  `).join("");
  return `<div class="task"><h4>Можно сделать тихо. Это не обязательно, но цель вечера в этом.</h4>
    <p>Аня просила молчать. Ты можешь сказать одному человеку, что её сегодня не будет.</p>${buttons}</div>`;
}

function whisperNote(player) {
  if (state.actions.whisperTo !== player.id) return "";
  const kira = nameOf("kira");
  const lesha = nameOf("lesha");
  const text = player.id === "lesha"
    ? `${kira} тихо, только тебе: «Аня просила, чтобы ты думал, что её сегодня нет. Я не хочу быть единственной, кто это знает».`
    : `${kira} тихо, только тебе: «Аня не опаздывает. Она просила сказать, что её сегодня не было. Особенно — ${lesha}».`;
  return `<div class="whisper-note">${esc(text)}</div>`;
}

function phoneHTML(player) {
  const role = roleOf(player.id);
  return `<div class="sheet">
    <article class="device-lg${paintedOpen !== player.id ? " rise" : ""}">
      <div class="phone-top"><span>личный экран</span><span>${esc(role.title)}</span></div>
      <h3>${esc(nameOf(player.id))}</h3>
      <div class="paper">
        <p class="role-title">${esc(role.title)}</p>
        <p>${esc(role.public)}</p>
        <p><span class="lbl">Секрет</span>${esc(role.secret)}</p>
        <p><span class="lbl">Хочется</span>${esc(role.goal)}</p>
      </div>
      ${whisperNote(player)}
      ${taskHTML(player)}
      ${whisperHTML(player)}
      <button type="button" class="linkish" data-act="close-phone">К столу</button>
    </article>
  </div>`;
}

function statusOf(player) {
  if (needs(player)) return state.beat === 0 ? "роль не открыта" : "ждёт решение";
  const actions = state.actions;
  if (state.beat === 0) return "секрет при себе";
  if (state.beat === 1) return { cut: "режет молча", wait: "ждёт Аню", ask: "хочет спросить" }[actions.cake[player.id]];
  if (state.beat === 2 && player.id === "timur") return actions.jacketHidden ? "спрятал куртку" : "оставил куртку";
  if (state.beat === 2) {
    return { timur: "думает на друга", lesha: "думает на коллегу", stranger: "думает, куртка чужая", quiet: "молчит про куртку" }[actions.jacketGuess[player.id]];
  }
  if (state.beat === 3) return "тост сказан";
  if (state.beat === 4) return actions.stay[player.id] === "stay" ? "остаётся" : "встаёт";
  if (state.beat === 5) return `зовёт ${nameOf(actions.kitchen[player.id])}`;
  return roleOf(player.id).title;
}

function devicesHTML() {
  return `<div class="phones">${state.players.map((player) => {
    const open = state.openId === player.id;
    const waiting = needs(player);
    const role = state.actions.seen[player.id] ? roleOf(player.id).title : "телефон закрыт";
    const flag = state.actions.whisperTo === player.id ? `<span class="flag">шёпот</span>` : "";
    return `<button type="button" class="device${waiting ? " needs" : ""}${open ? " is-open" : ""}" style="--c:${COLORS[player.id]}" data-act="open-phone" data-id="${player.id}">
      <i class="dot"></i>
      <strong class="who">${esc(nameOf(player.id))}</strong>
      <em class="role">${esc(role)}</em>
      <span class="status">${esc(statusOf(player))}</span>
      ${flag}
    </button>`;
  }).join("")}</div>`;
}

function letterHTML(rise) {
  const view = beatView();
  const ping = view.ping ? `<div class="ping"><div><b>${esc(view.ping[0])}</b><p>${esc(view.ping[1])}</p></div></div>` : "";
  const extra = state.beat === 6 ? scoreList() : resultHTML();
  const foot = state.beat === 6
    ? `<button type="button" class="btn" data-act="poster">Карточка вечера</button>`
    : beatComplete()
      ? `<button type="button" class="btn" data-act="next">Дальше</button>`
      : `<p class="waiting">Ещё не ответили: ${esc(joinNames(state.players.filter(needs).map((player) => nameOf(player.id))))}</p>`;
  return `<article class="letter${rise ? " rise" : ""}">
    <div class="kicker"><span>${esc(view.kicker)}</span><span>0${state.beat + 1} / 07</span></div>
    <h2>${esc(view.title)}</h2>
    ${view.body}
    ${ping}
    ${extra}
    <div class="foot">${foot}</div>
  </article>`;
}

function landingHTML() {
  return `<div class="top"><span>СВОИ</span><span>локальный прототип</span></div>
    <main class="landing"><div class="wrap">
      <div class="glasses" aria-hidden="true"><span></span><span></span><span></span><span></span><span class="empty"></span></div>
      <p class="eyebrow">Вечер на четверых</p>
      <h1>День рождения,<br>которого не было</h1>
      <p class="lede">Именинницы нет дома. На торте написано «пока». У каждого в телефоне роль, секрет и фраза, собранная из его собственных ответов.</p>
      <button type="button" class="btn" data-act="lobby">Собрать стол</button>
      <p class="fine">Один браузер: общий экран читают вслух, четыре телефона снизу открывают по одному. Так за столом выглядит серия.</p>
      <ul class="occasions">
        <li class="on"><b>Друзья</b><span>этот стол</span></li>
        <li><b>Свидание</b><span>серия «Кухня» позже</span></li>
        <li><b>Компания</b><span>серия «Пятница» позже</span></li>
      </ul>
    </div></main>`;
}

function lobbyHTML() {
  const cards = state.players.map((player) => `<article class="guest">
    <div class="guest-name"><i class="dot" style="--c:${COLORS[player.id]}"></i>
      <input data-pid="${player.id}" data-field="name" value="${esc(player.name)}" maxlength="24" aria-label="Имя" />
    </div>
    ${QUESTIONS.map((question) => `<label><small>${esc(question.label)}</small>
      <textarea data-pid="${player.id}" data-field="${question.id}" rows="2" maxlength="90">${esc(player.answers[question.id])}</textarea>
    </label>`).join("")}
  </article>`).join("");
  const error = state.error ? `<p class="error">${esc(state.error)}</p>` : "";
  return `<main class="lobby">
    <header class="lobby-head">
      <p class="eyebrow">Перед тем как сесть</p>
      <h1>Тихие ответы</h1>
      <p class="lede">Из этих строк соберутся тосты. Роли серии уже разложены. Имена и ответы можно поправить.</p>
    </header>
    <div class="grid">${cards}</div>
    ${error}
    <button type="button" class="btn" data-act="begin">Начать вечер</button>
  </main>`;
}

function playHTML() {
  const rise = paintedScreen !== "play" || paintedBeat !== state.beat;
  const phone = state.openId ? phoneHTML(state.players.find((player) => player.id === state.openId)) : "";
  return `<main class="stage">
    <header class="bar">
      <div><strong>СВОИ</strong><span>День рождения, которого не было</span></div>
      <div class="dots">${Array.from({ length: 7 }, (_, index) => `<i class="${index === state.beat ? "now" : ""} ${index < state.beat ? "done" : ""}"></i>`).join("")}</div>
    </header>
    ${letterHTML(rise)}
    ${devicesHTML()}
    <p class="hint">Общий экран — для стола. Телефон с тёплой кромкой открывают по одному: там личное.</p>
    ${phone}
  </main>`;
}

function posterHTML() {
  const masha = state.players.find((player) => player.id === "masha");
  return `<main class="poster-wrap">
    <article class="poster">
      <p class="eyebrow">СВОИ · серия 01</p>
      <h2>День рождения, которого не было</h2>
      <p class="poster-lead">Четыре бокала и один лишний.</p>
      ${scoreList()}
      <p class="sign">В три ночи ${esc(nameOf("masha"))} напишет ${esc(masha.answers.night.trim())}. Аня уже в поезде.</p>
    </article>
    <div class="poster-actions">
      <button type="button" class="btn" data-act="replay">Сыграть ещё раз</button>
      <button type="button" class="btn ghost" data-act="home">На начало</button>
    </div>
  </main>`;
}

function render() {
  const openRiseId = state.openId;
  if (state.screen === "landing") app.innerHTML = landingHTML();
  else if (state.screen === "lobby") app.innerHTML = lobbyHTML();
  else if (state.screen === "play") app.innerHTML = playHTML();
  else app.innerHTML = posterHTML();
  paintedScreen = state.screen;
  paintedBeat = state.beat;
  paintedOpen = openRiseId;
}

function replay() {
  const players = clonePlayers();
  state = fresh();
  state.players = players;
  state.screen = "play";
  render();
}

app.addEventListener("input", (event) => {
  const field = event.target.dataset.field;
  const pid = event.target.dataset.pid;
  if (!field || !pid) return;
  const player = state.players.find((item) => item.id === pid);
  if (!player) return;
  if (field === "name") player.name = event.target.value;
  else player.answers[field] = event.target.value;
});

app.addEventListener("click", (event) => {
  if (event.target.classList.contains("sheet")) {
    state.openId = null;
    render();
    return;
  }
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const act = button.dataset.act;
  if (act === "lobby") {
    state.screen = "lobby";
    state.error = "";
    render();
  } else if (act === "begin") {
    if (!answersReady()) {
      state.error = "Нужны имя и три тихих ответа у каждого — из них собирается вечер.";
      render();
      return;
    }
    state.error = "";
    state.actions = emptyActions();
    state.beat = 0;
    state.openId = null;
    state.screen = "play";
    render();
  } else if (act === "open-phone") {
    state.openId = button.dataset.id;
    render();
  } else if (act === "close-phone") {
    state.openId = null;
    render();
  } else if (act === "pick") {
    state.actions[button.dataset.key][button.dataset.id] = button.dataset.value;
    render();
  } else if (act === "hide") {
    state.actions.jacketHidden = button.dataset.value === "1";
    render();
  } else if (act === "whisper") {
    state.actions.whisperTo = button.dataset.id;
    render();
  } else if (act === "next") {
    if (!beatComplete()) return;
    state.beat += 1;
    state.openId = null;
    render();
  } else if (act === "poster") {
    state.screen = "poster";
    state.openId = null;
    render();
  } else if (act === "replay") {
    replay();
  } else if (act === "home") {
    const players = clonePlayers();
    state = fresh();
    state.players = players;
    render();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.openId) {
    state.openId = null;
    render();
  }
});

render();
