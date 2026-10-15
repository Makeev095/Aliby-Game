function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[char]));
}

const root = document.getElementById("table");
const code = root.dataset.code;
const key = "alibi:" + code;
const gate = document.getElementById("gate");
const room = document.getElementById("room");
const joinForm = document.getElementById("join-form");
const joinError = document.getElementById("join-error");

function token() {
  return sessionStorage.getItem(key) || "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Player-Token": token(),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Ошибка стола");
  return data;
}

function seat(player, state) {
  const article = document.createElement("article");
  article.className = "seat" + (state.reveal && player.id === state.reveal.thief_id ? " thief" : "");
  const title = player.role ? player.role.name : player.name;
  const relation = player.role ? `${player.name} · ${player.role.relation}` : "Ждёт свою роль";
  const photo = player.role ? `<img src="/static/img/portrait-${esc(player.role.id)}.jpg" alt="">` : "";
  article.innerHTML = `${photo}<small>${player.host ? "Открыл стол" : "За столом"}</small><b>${esc(title)}</b><span>${esc(relation)}</span>`;
  if (state.phase !== "lobby" && state.phase !== "reveal" && state.you && player.id !== state.you.id) {
    const button = document.createElement("button");
    button.className = "vote";
    button.type = "button";
    button.textContent = state.you.vote === player.id ? "Ваш голос" : "Это он";
    button.addEventListener("click", async () => {
      await api(`/api/rooms/${code}/vote`, { method: "POST", body: JSON.stringify({ player_id: player.id }) });
      await refresh();
    });
    article.appendChild(button);
  }
  return article;
}

function draw(state) {
  gate.hidden = true;
  room.hidden = false;
  document.getElementById("brief").textContent = state.case.brief;
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = "";
  state.case.timeline.forEach(([time, text]) => {
    const item = document.createElement("li");
    item.innerHTML = `<span>${time}</span>${text}`;
    timeline.appendChild(item);
  });
  const plan = document.getElementById("plan");
  plan.hidden = state.phase === "lobby";
  plan.innerHTML = "";
  (state.places || []).forEach((place) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "place" + (place.clue ? " open" : "");
    button.innerHTML = `<b>${esc(place.name)}</b><span>${place.clue ? esc(place.clue) : "Открыть комнату"}</span>`;
    if (!place.clue && state.phase !== "lobby") {
      button.addEventListener("click", async () => {
        await api(`/api/rooms/${code}/look`, { method: "POST", body: JSON.stringify({ place: place.id }) });
        await refresh();
      });
    }
    plan.appendChild(button);
  });
  const seats = document.getElementById("seats");
  seats.innerHTML = "";
  state.players.forEach((player) => seats.appendChild(seat(player, state)));
  const actions = document.getElementById("room-actions");
  actions.innerHTML = "";
  if (state.phase === "lobby") {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = `За столом ${state.players.length} из ${state.max}. Роли раздаются от ${state.need}.`;
    actions.appendChild(note);
    if (state.you && state.you.host) {
      const button = document.createElement("button");
      button.className = "btn";
      button.type = "button";
      button.textContent = "Раздать роли";
      button.disabled = state.players.length < state.need;
      button.addEventListener("click", async () => {
        try {
          await api(`/api/rooms/${code}/start`, { method: "POST", body: "{}" });
          await refresh();
        } catch (error) {
          note.textContent = error.message;
        }
      });
      actions.appendChild(button);
    }
  }
  const hand = document.getElementById("hand");
  const card = document.getElementById("hand-card");
  if (state.you && state.you.role && state.phase !== "reveal") {
    hand.hidden = false;
    card.innerHTML = `<img src="/static/img/portrait-${esc(state.you.role.id)}.jpg" alt=""><p class="kicker">${esc(state.you.role.relation)}</p><h2>${esc(state.you.role.name)}</h2><p><b>Скажите за столом.</b> ${esc(state.you.role.say)}</p><div class="secret"><b>Только вам.</b> ${esc(state.you.role.secret)}</div>`;
  } else {
    hand.hidden = true;
  }
  if (state.reveal) {
    const block = document.createElement("div");
    block.className = "reveal";
    const votes = state.reveal.cards.map((item) => `${esc(item.player_name)} (${esc(item.role)}) → ${esc(item.vote || "молчит")}`).join("<br>");
    block.innerHTML = `<p class="kicker">Стол вскрыт</p><h2>Конверт у ${esc(state.reveal.thief_role)}</h2><p>Его играл ${esc(state.reveal.thief_name)}.</p><p>${state.reveal.chain.map(esc).join(" ")}</p><p>${votes}</p>`;
    actions.appendChild(block);
  }
}

async function refresh() {
  if (!token()) return;
  try {
    draw(await api(`/api/rooms/${code}`));
  } catch (error) {
    sessionStorage.removeItem(key);
    gate.hidden = false;
    room.hidden = true;
    joinError.hidden = false;
    joinError.textContent = error.message;
  }
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  joinError.hidden = true;
  try {
    const data = await api(`/api/rooms/${code}/join`, {
      method: "POST",
      body: JSON.stringify({ name: joinForm.name.value.trim() }),
    });
    sessionStorage.setItem(key, data.token);
    await refresh();
  } catch (error) {
    joinError.hidden = false;
    joinError.textContent = error.message;
  }
});

document.getElementById("copy-link").addEventListener("click", async () => {
  const link = location.origin + "/play/" + code;
  try {
    await navigator.clipboard.writeText(link);
    document.getElementById("copy-link").textContent = "Ссылка у вас";
  } catch {
    document.getElementById("copy-link").textContent = link;
  }
});

if (token()) refresh();
setInterval(refresh, 1600);
