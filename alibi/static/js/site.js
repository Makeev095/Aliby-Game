const loader = document.getElementById("loader");
window.addEventListener("load", () => {
  setTimeout(() => document.body.classList.add("is-ready"), 450);
});

const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
const cursor = document.getElementById("cursor");
const glow = document.getElementById("glow");
if (fine) {
  document.body.classList.add("has-cursor");
  window.addEventListener("pointermove", (event) => {
    cursor.style.left = event.clientX + "px";
    cursor.style.top = event.clientY + "px";
    glow.style.left = event.clientX + "px";
    glow.style.top = event.clientY + "px";
  });
}

const sheet = document.getElementById("table-sheet");
const form = document.getElementById("table-form");
const error = document.getElementById("table-error");
document.querySelectorAll("[data-open-table]").forEach((button) => {
  button.addEventListener("click", () => {
    sheet.hidden = false;
    form.name.focus();
  });
});
document.querySelectorAll("[data-close-table]").forEach((button) => {
  button.addEventListener("click", () => { sheet.hidden = true; });
});
sheet.addEventListener("click", (event) => {
  if (event.target === sheet) sheet.hidden = true;
});
const soundButton = document.getElementById("sound");
function paintSound(on) {
  document.body.classList.toggle("sound-on", on);
  soundButton.setAttribute("aria-pressed", on ? "true" : "false");
  soundButton.setAttribute("aria-label", on ? "Выключить звук" : "Включить звук");
}
paintSound(false);
const score = {
  ctx: null,
  timer: null,
  live: false,
  starting: false,
  wanted: sessionStorage.getItem("alibi-sound") !== "off",
  async start() {
    if (!this.wanted || this.live || this.starting) return;
    this.starting = true;
    try {
    const ctx = new AudioContext();
    this.ctx = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    if (ctx.state !== "running") return;
    const master = ctx.createGain();
    master.gain.value = 0.22;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 520;
    filter.connect(master);
    master.connect(ctx.destination);
    const bed = (freq, type, level) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.value = level;
      osc.connect(gain);
      gain.connect(filter);
      osc.start();
    };
    bed(110, "sine", 0.09);
    bed(164.81, "triangle", 0.035);
    bed(55, "sine", 0.06);
    const notes = [196, 220, 246.94, 174.61, 233.08, 261.63];
    const chime = () => {
      if (!this.live) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = notes[Math.floor(Math.random() * notes.length)];
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.6);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 5);
      osc.connect(gain);
      gain.connect(filter);
      osc.start();
      osc.stop(ctx.currentTime + 5.1);
    };
    this.timer = setInterval(chime, 5600);
    chime();
    this.live = true;
    this.crackle = setInterval(() => crackle(this.ctx), 520);
    paintSound(true);
    } finally {
      this.starting = false;
    }
  },
  async stop() {
    clearInterval(this.timer);
    clearInterval(this.crackle);
    wingPasses.length = 0;
    this.live = false;
    if (this.ctx) await this.ctx.close();
    this.ctx = null;
    paintSound(false);
  },
};
document.getElementById("sound").addEventListener("click", async (event) => {
  event.stopPropagation();
  if (score.live) {
    score.wanted = false;
    sessionStorage.setItem("alibi-sound", "off");
    await score.stop();
    return;
  }
  score.wanted = true;
  sessionStorage.removeItem("alibi-sound");
  await score.start();
});
const wake = () => { score.start(); };
window.addEventListener("pointerdown", wake);
score.start();

const bats = [...document.querySelectorAll(".bat")];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
function crackle(ctx) {
  if (!ctx || ctx.state !== "running") return;
  const t = ctx.currentTime;
  const dur = 0.05 + Math.random() * 0.09;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 700 + Math.random() * 1600;
  band.Q.value = 0.6;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.03 + Math.random() * 0.035, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(band);
  band.connect(gain);
  gain.connect(ctx.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}
const wingPasses = [];
function wingSound(seconds, fromRight) {
  if (!score.live || !score.ctx) return;
  const ctx = score.ctx;
  const t0 = ctx.currentTime;
  for (let i = wingPasses.length - 1; i >= 0; i -= 1) {
    if (wingPasses[i] <= t0) wingPasses.splice(i, 1);
  }
  if (wingPasses.length >= 2) return;
  const far = wingPasses.length === 1;
  wingPasses.push(t0 + seconds);
  const level = far ? 0.55 : 1;
  const flap = far ? 0.29 : 0.17;
  const rate = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.floor(rate * seconds), rate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.setValueAtTime(far ? 1400 : 700, t0);
  band.frequency.linearRampToValueAtTime(far ? 2200 : 1600, t0 + seconds * 0.45);
  band.frequency.linearRampToValueAtTime(far ? 1100 : 640, t0 + seconds);
  band.Q.value = far ? 1.1 : 0.7;
  const flutter = ctx.createGain();
  flutter.gain.setValueAtTime(0.0001, t0);
  const phase = far ? flap * 0.5 : 0;
  for (let at = 0.12 + phase; at < seconds - 0.2; at += flap) {
    const closer = Math.sin((at / seconds) * Math.PI);
    const peak = (0.01 + closer * 0.07) * level;
    flutter.gain.setValueAtTime(0.0001, t0 + at);
    flutter.gain.linearRampToValueAtTime(Math.max(peak, 0.0002), t0 + at + 0.02);
    flutter.gain.exponentialRampToValueAtTime(0.0008, t0 + at + 0.08);
  }
  const body = ctx.createOscillator();
  body.type = "sine";
  body.frequency.setValueAtTime(far ? 96 : 68, t0);
  body.frequency.linearRampToValueAtTime(far ? 140 : 104, t0 + seconds * 0.5);
  body.frequency.linearRampToValueAtTime(far ? 80 : 58, t0 + seconds);
  const bodyGain = ctx.createGain();
  bodyGain.gain.setValueAtTime(0.0001, t0);
  bodyGain.gain.exponentialRampToValueAtTime((far ? 0.012 : 0.035), t0 + seconds * 0.45);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
  const pan = ctx.createStereoPanner();
  const edge = far ? 0.28 : 0.75;
  pan.pan.setValueAtTime(fromRight ? edge : -edge, t0);
  pan.pan.linearRampToValueAtTime(fromRight ? -edge : edge, t0 + seconds);
  src.connect(band);
  band.connect(flutter);
  flutter.connect(pan);
  body.connect(bodyGain);
  bodyGain.connect(pan);
  pan.connect(ctx.destination);
  src.start(t0);
  src.stop(t0 + seconds);
  body.start(t0);
  body.stop(t0 + seconds);
}
function releaseBat() {
  const bat = bats.find((item) => !item.classList.contains("is-flying"));
  if (!bat || reducedMotion) return;
  const routes = ["bat-1", "bat-2", "bat-3", "bat-4"];
  const route = routes[Math.floor(Math.random() * routes.length)];
  const seconds = 5.2 + Math.random() * 3.4;
  bat.classList.remove("is-flying");
  bat.style.top = (2 + Math.random() * 68) + "vh";
  bat.style.setProperty("--bat-dur", seconds + "s");
  bat.style.setProperty("--bat-route", route);
  void bat.offsetWidth;
  bat.classList.add("is-flying");
  wingSound(seconds, route === "bat-2" || route === "bat-3");
  bat.addEventListener("animationend", (event) => {
    if (event.target !== bat) return;
    bat.classList.remove("is-flying");
  }, { once: true });
}
function queueBats() {
  if (reducedMotion) return;
  releaseBat();
  if (Math.random() > 0.4) setTimeout(releaseBat, 1100 + Math.random() * 1800);
  setTimeout(queueBats, 11000 + Math.random() * 12000);
}
setTimeout(queueBats, 1600);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  const name = form.name.value.trim();
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await response.json();
  if (!response.ok) {
    error.hidden = false;
    error.textContent = data.error || "Не получилось открыть стол.";
    return;
  }
  sessionStorage.setItem("alibi:" + data.code, data.token);
  location.href = "/play/" + data.code;
});

(function burn() {
  const canvas = document.querySelector(".hearth-fire");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: true });
  const photo = new Image();
  photo.src = "/static/img/fireplace.png";
  let base = null;
  let frame = null;
  let baked = 0;
  const sway = new Float32Array(4096);
  const stretch = new Float32Array(4096);
  const hot = new Float32Array(4096);

  function fit() {
    const wide = window.innerWidth > 980;
    const squash = wide ? 0.34 : 0.7;
    const cssW = Math.max(1, Math.round(canvas.parentElement.clientWidth));
    const cssH = Math.max(1, Math.round(cssW * (720 / 1280) * squash));
    if (cssW === baked && base) return;
    baked = cssW;
    canvas.width = cssW;
    canvas.height = cssH;
    canvas.style.height = cssH + "px";
    ctx.drawImage(photo, 0, 0, cssW, cssH);
    base = ctx.getImageData(0, 0, cssW, cssH);
    frame = ctx.createImageData(cssW, cssH);
  }

  function paint(now) {
    const t = now * 0.001;
    const w = base.width;
    const h = base.height;
    const src = base.data;
    const dst = frame.data;
    dst.set(src);
    const anchor = (h * 0.86) | 0;
    const top = (h * 0.1) | 0;
    const span = anchor - top;
    const n = w < 4096 ? w : 4096;
    const flameAt = (i) => {
      const a = src[i + 3];
      const r = src[i];
      const g = src[i + 1];
      const b = src[i + 2];
      return a > 24 && r > 150 && r > g + 18 && r > b + 45 && g > 50;
    };
    for (let x = 0; x < n; x++) {
      const n1 = Math.sin(t * 6.4 + x * 0.042);
      const n2 = Math.sin(t * 2.4 + x * 0.013 + 1.2);
      const n3 = Math.sin(t * 13.5 + x * 0.11);
      stretch[x] = 0.78 + (n1 * 0.5 + 0.5) * 0.22 + (n2 * 0.5 + 0.5) * 0.16;
      sway[x] = n2 * 9 + n3 * 4;
      hot[x] = 0.82 + (n3 * 0.5 + 0.5) * 0.5 + (n1 * 0.5 + 0.5) * 0.28;
    }
    for (let y = top; y < anchor; y++) {
      const dy = anchor - y;
      const along = dy / span;
      const bend = along * along;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const o = (row + x) * 4;
        const open = src[o + 3] < 18;
        if (!open && !flameAt(o)) continue;
        let sy = y + (1 - stretch[x]) * dy * 0.85 + Math.sin(t * 9 + x * 0.08) * 5 * along;
        let sx = x + sway[x] * bend;
        if (sy < 0) sy = 0;
        else if (sy > h - 1) sy = h - 1;
        if (sx < 0) sx = 0;
        else if (sx > w - 1) sx = w - 1;
        const si = ((sy | 0) * w + (sx | 0)) * 4;
        if (!flameAt(si)) {
          if (open) dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0;
          else {
            const heat = 0.75 + hot[x] * 0.35;
            dst[o] = Math.min(255, src[o] * heat);
            dst[o + 1] = Math.min(255, src[o + 1] * (0.9 + heat * 0.12));
            dst[o + 2] = Math.min(255, src[o + 2] * 0.85);
          }
          continue;
        }
        const heat = 0.7 + hot[x] * along * 0.55 + 0.35;
        dst[o] = Math.min(255, src[si] * heat);
        dst[o + 1] = Math.min(255, src[si + 1] * (0.88 + heat * 0.14));
        dst[o + 2] = Math.min(255, src[si + 2] * 0.8);
        dst[o + 3] = src[si + 3];
      }
    }
    for (let y = anchor; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const o = (row + x) * 4;
        if (!flameAt(o)) continue;
        const tw = 0.84 + 0.28 * Math.sin(t * 14 + x * 0.17 + y * 0.23);
        dst[o] = Math.min(255, src[o] * tw);
        dst[o + 1] = Math.min(255, src[o + 1] * (0.9 + tw * 0.12));
      }
    }
    ctx.putImageData(frame, 0, 0);
  }

  function loop(now) {
    paint(now);
    requestAnimationFrame(loop);
  }

  photo.onload = () => {
    fit();
    if (reducedMotion) return;
    requestAnimationFrame(loop);
  };
  window.addEventListener("resize", () => {
    if (photo.complete && photo.naturalWidth) fit();
  });
})();
