"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const audio = $("#audio");
const isLocal = ["127.0.0.1", "localhost"].includes(location.hostname);
const android = window.MusicHubAndroid || null;
const SOURCE_NAMES = { all: "Все", yandex: "Яндекс Музыка", soundcloud: "SoundCloud", spotify: "Spotify", youtube: "YouTube", file: "Файл" };
const SHORT_NAMES = { yandex: "Яндекс", soundcloud: "SoundCloud", spotify: "Spotify", youtube: "YouTube", file: "Файл" };
const state = { sources: [], filter: "all", queue: [], index: -1, settings: {} };

// ---------- утилиты ----------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}
function setIcon(btn, name) { const u = btn.querySelector("use"); if (u) u.setAttribute("href", "#i-" + name); }
function iconBtn(name, label, onclick, cls = "icon-btn") {
  return el("button", { class: cls, type: "button", "aria-label": label, title: label, onclick }, icon(name));
}
function fmt(sec) {
  if (!sec || !isFinite(sec)) return "0:00";
  sec = Math.floor(sec);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem("musichub-" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("musichub-" + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};
let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3600);
}
async function api(path, opts = {}) {
  if (opts.json !== undefined) {
    opts = { ...opts, method: opts.method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.json) };
  }
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `Ошибка ${r.status}`);
  return data;
}

// ---------- тема ----------
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme(value) {
  // тема хранится строкой (не JSON): её читает скрипт в <head> ещё до загрузки стилей
  try { localStorage.setItem("musichub-theme", value); } catch { /* ignore */ }
  if (value === "light" || value === "dark") document.documentElement.setAttribute("data-theme", value);
  else document.documentElement.removeAttribute("data-theme");
  $$("#theme-switch button").forEach((b) => b.classList.toggle("active", b.dataset.themeValue === value));
  syncThemeColor();
}
function currentTheme() { try { return localStorage.getItem("musichub-theme") || "system"; } catch { return "system"; } }
function syncThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  const t = document.documentElement.getAttribute("data-theme");
  const dark = t ? t === "dark" : darkQuery.matches;
  $('meta[name="theme-color"]').setAttribute("content", bg);
  if (android && android.setTheme) try { android.setTheme(bg, dark); } catch { /* старая версия приложения */ }
}
$$("#theme-switch button").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.themeValue)));
darkQuery.addEventListener("change", syncThemeColor);
applyTheme(currentTheme());

// ---------- вкладки ----------
function showTab(name) {
  $$("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  $("#main").scrollTop = 0;
  if (name === "library") loadLibrary();
  if (name === "settings") loadSettings();
  if (name === "queue") renderQueue();
}
$$("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------- источники и поиск ----------
async function loadSources() {
  state.sources = await api("/api/sources");
  const box = $("#source-filter"); box.innerHTML = "";
  for (const s of [{ name: "all", title: "Все", available: true }, ...state.sources]) {
    box.append(el("button", {
      class: "chip" + (s.name === state.filter ? " active" : "") + (s.available ? "" : " off"), type: "button",
      title: s.available ? null : "Не настроено — откройте «Настройки»",
      onclick: () => { state.filter = s.name; loadSources(); if ($("#q").value.trim()) doSearch(); },
    }, s.name === "all" ? null : el("span", { class: "dot s-" + s.name }), SHORT_NAMES[s.name] || s.title));
  }
}

$("#search-form").addEventListener("submit", (e) => { e.preventDefault(); $("#q").blur(); doSearch(); });
$("#q").addEventListener("input", () => { $("#q-clear").hidden = !$("#q").value; });
$("#q-clear").addEventListener("click", () => {
  $("#q").value = ""; $("#q-clear").hidden = true; $("#results").innerHTML = ""; $("#status").textContent = "";
  $("#search-empty").hidden = false; renderRecent(); $("#q").focus();
});

function renderRecent() {
  const box = $("#recent"); box.innerHTML = "";
  for (const q of store.get("recent", [])) {
    box.append(el("button", { class: "chip", type: "button", onclick: () => { $("#q").value = q; $("#q-clear").hidden = false; doSearch(); } }, q));
  }
}
function remember(q) {
  if (/^https?:\/\//.test(q)) return;
  store.set("recent", [q, ...store.get("recent", []).filter((x) => x !== q)].slice(0, 8));
}

function skeleton(n = 6) {
  const box = el("div");
  for (let i = 0; i < n; i++) {
    box.append(el("div", { class: "track skeleton" }, el("div", { class: "art" }), el("div", {}, el("div", { class: "t" }), el("div", { class: "a" }))));
  }
  return box;
}
function startLoading(text) {
  $("#search-empty").hidden = true;
  $("#status").textContent = text;
  const box = $("#results"); box.innerHTML = ""; box.append(skeleton());
}

async function doSearch() {
  const q = $("#q").value.trim();
  if (!q) return;
  remember(q);
  startLoading("Ищу…");
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&source=${state.filter}`);
    renderResults(data);
    const n = Object.values(data.results).reduce((a, l) => a + l.length, 0);
    $("#status").textContent = n ? `Найдено: ${n}` : "";
    if (!n && !Object.keys(data.errors).length) $("#results").append(el("div", { class: "empty" }, "Ничего не нашлось. Попробуйте написать иначе."));
  } catch (err) { $("#results").innerHTML = ""; $("#status").textContent = ""; $("#results").append(el("div", { class: "alert" }, err.message)); }
}

function renderResults(data) {
  const box = $("#results"); box.innerHTML = "";
  $("#search-empty").hidden = true;
  for (const src of ["yandex", "soundcloud", "spotify", "youtube"]) {
    const list = data.results[src], error = data.errors[src];
    if (!(list && list.length) && !error) continue;
    box.append(el("div", { class: "section-head" }, el("span", { class: "src-dot s-" + src }),
      el("h3", {}, SOURCE_NAMES[src]), list && list.length ? el("span", { class: "n" }, String(list.length)) : null));
    if (error) box.append(el("div", { class: "alert" }, error));
    (list || []).forEach((t, i) => box.append(trackRow(t, () => playList(list, i))));
  }
  highlight(state.queue[state.index]);
}

function trackRow(t, onPlay, extraActs = []) {
  const art = el("div", { class: "art", onclick: onPlay },
    t.artwork ? el("img", { src: t.artwork, loading: "lazy", alt: "" }) : icon("logo"),
    el("div", { class: "ov" }, icon("play")),
    el("div", { class: "eq" }, el("i"), el("i"), el("i")));
  const acts = [iconBtn("plus", "В очередь", () => addToQueue(t))];
  acts.push(iconBtn("download", android ? "Скачать на телефон" : "Скачать на компьютер", (e) => saveToPc(t, e.currentTarget)));
  if (!isLocal && !android) acts.push(iconBtn("phone", "Скачать на это устройство", (e) => saveToDevice(t, e.currentTarget)));
  return el("div", { class: "track", "data-key": t.key || "" },
    art,
    el("div", { class: "meta", onclick: onPlay },
      el("div", { class: "t" }, t.title),
      el("div", { class: "a" },
        el("span", { class: "src-dot s-" + t.source, title: SOURCE_NAMES[t.source] }),
        t.explicit ? el("span", { class: "tag e", title: "Без цензуры (explicit)" }, "E") : null,
        t.protected ? el("span", { class: "tag", title: "Источник закрыл звук (DRM, отрывок или недоступно в регионе) — найдём этот трек в других сервисах" }, icon("lock"), "замена") : null,
        el("span", { class: "who" }, t.artist || SHORT_NAMES[t.source] || ""))),
    el("div", { class: "dur" }, t.duration ? fmt(t.duration) : ""),
    el("div", { class: "acts" }, ...extraActs, ...acts));
}

function addToQueue(t) {
  state.queue.push(t);
  if (state.index < 0) state.index = 0;
  updateQueueCount();
  toast("Добавлено в очередь");
}
function updateQueueCount() {
  const left = state.queue.length ? state.queue.length - Math.max(state.index, 0) - 1 : 0;
  $$("[data-queue-count]").forEach((n) => (n.textContent = left > 0 ? String(left) : ""));
}

// ---------- скачивание ----------
async function saveToPc(t, btn) {
  if (android) return saveToDevice(t, btn);   // в Android-приложении — в «Музыку» телефона
  btn.disabled = true; btn.classList.add("busy");
  try {
    const r = await api("/api/download", { json: t });
    toast("Сохранено: " + r.path); setIcon(btn, "check");
  } catch (err) { toast(err.message); }
  btn.disabled = false; btn.classList.remove("busy");
}
async function saveToDevice(t, btn) {
  if (btn) btn.disabled = true;
  try {
    if (t.source === "file") {
      const url = `/api/library/${encodeURIComponent(t.id)}?attachment=true`;
      if (android) android.download(url, t.id.replace(/\.[^.]+$/, ""));
      else location.href = url;
      return;
    }
    toast("Готовлю файл…");
    const r = await api("/api/prepare", { json: t });
    const url = "/api/file/" + encodeURI(r.key);
    if (android) { android.download(url, (t.artist ? t.artist + " - " : "") + t.title); toast("Скачиваю в «Музыка/MusicHub»…"); }
    else location.href = url;
    if (btn) setIcon(btn, "check");
  } catch (err) { toast(err.message); }
  finally { if (btn) btn.disabled = false; }
}

// ---------- плеер ----------
function playList(list, i) { state.queue = list.slice(); state.index = i; playCurrent(); }

let playToken = 0;
let currentVia = "";
function setNowInfo(t, artistLine) {
  const art = t.artwork || "/static/cover.svg";
  $("#p-title").textContent = t.title; $("#p-artist").textContent = artistLine;
  $("#p-art").src = art; $("#now-art").src = art; $("#now-bg").src = art;
  $("#now-title").textContent = t.title; $("#now-artist").textContent = t.artist || "";
  document.title = `${t.title} — MusicHub`;
}
function setLoading(on) { ["#p-play", "#now-play"].forEach((s) => $(s).classList.toggle("loading", on)); }

async function playCurrent() {
  const t = state.queue[state.index];
  if (!t) return;
  const token = ++playToken;
  currentVia = "";
  audio.pause();
  setRange($("#p-bar"), 0); setRange($("#now-bar"), 0); $("#mini-progress").style.width = "0";
  $("#p-cur").textContent = $("#now-cur").textContent = "0:00";
  $("#p-dur").textContent = $("#now-dur").textContent = t.duration ? fmt(t.duration) : "0:00";
  setNowInfo(t, "Загрузка…");
  $("#now-via").textContent = "";
  setLoading(true);
  highlight(t); updateQueueCount();
  try {
    let src, via = null;
    if (t.source === "file") src = `/api/library/${encodeURIComponent(t.id)}`;
    else { const r = await api("/api/prepare", { json: t }); src = encodeURI(r.audio); via = r.via_title; }
    if (token !== playToken) return;           // пользователь уже включил другой трек
    audio.src = src;
    currentVia = via || "";
    $("#p-artist").textContent = (t.artist || "") + (via ? ` · звук: ${via}` : "");
    $("#now-via").textContent = via ? `Звук взят из «${via}»` : (t.source !== "file" ? SOURCE_NAMES[t.source] : "");
    setMediaSession(t);
    eqBeforePlay();
    await audio.play();
    prefetchNext();
  } catch (err) {
    if (token !== playToken) return;
    $("#p-artist").textContent = t.artist || "";
    toast(err.message);
  } finally {
    if (token === playToken) setLoading(false);
  }
}
function prefetchNext() {
  const n = state.queue[state.index + 1];
  if (n && n.source !== "file") api("/api/prepare", { json: n }).catch(() => {});
}
function next() { if (state.index < state.queue.length - 1) { state.index++; playCurrent(); } }
function prev() {
  if (audio.currentTime > 5 || state.index <= 0) { audio.currentTime = 0; return; }
  state.index--; playCurrent();
}
function togglePlay() {
  if (!audio.src) { if (state.queue.length) { state.index = Math.max(state.index, 0); playCurrent(); } return; }
  if (audio.paused) { eqBeforePlay(); audio.play(); } else audio.pause();
}
function highlight(t) {
  $$(".track.playing").forEach((n) => n.classList.remove("playing"));
  if (t && t.key) $$(`.track[data-key="${CSS.escape(t.key)}"]`).forEach((n) => n.classList.add("playing"));
}
function setMediaSession(t) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist || "", artwork: t.artwork ? [{ src: t.artwork, sizes: "500x500" }] : [],
  });
  navigator.mediaSession.setActionHandler("previoustrack", prev);
  navigator.mediaSession.setActionHandler("nexttrack", next);
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
}

$("#p-play").addEventListener("click", togglePlay);
$("#now-play").addEventListener("click", togglePlay);
$("#p-next").addEventListener("click", next); $("#now-next").addEventListener("click", next);
$("#p-prev").addEventListener("click", prev); $("#now-prev").addEventListener("click", prev);
function onPlayState() {
  const playing = !audio.paused;
  ["#p-play", "#now-play"].forEach((s) => { setIcon($(s), playing ? "pause" : "play"); $(s).setAttribute("aria-label", playing ? "Пауза" : "Играть"); });
  document.body.classList.toggle("paused", !playing);
}
audio.addEventListener("play", onPlayState);
audio.addEventListener("pause", onPlayState);
audio.addEventListener("ended", next);

function setRange(input, frac) { input.value = Math.round(frac * 1000); input.style.setProperty("--p", (frac * 100).toFixed(2) + "%"); }
let seeking = false;
audio.addEventListener("timeupdate", () => {
  const frac = audio.duration ? audio.currentTime / audio.duration : 0;
  $("#p-cur").textContent = $("#now-cur").textContent = fmt(audio.currentTime);
  $("#p-dur").textContent = $("#now-dur").textContent = fmt(audio.duration);
  $("#mini-progress").style.width = (frac * 100).toFixed(2) + "%";
  if (!seeking) { setRange($("#p-bar"), frac); setRange($("#now-bar"), frac); }
});
for (const bar of [$("#p-bar"), $("#now-bar")]) {
  bar.addEventListener("input", () => { seeking = true; bar.style.setProperty("--p", bar.value / 10 + "%"); });
  bar.addEventListener("change", () => {
    if (audio.duration) audio.currentTime = (bar.value / 1000) * audio.duration;
    seeking = false;
  });
}
const vol = $("#p-vol");
function setVolume(v) { audio.volume = v; vol.value = Math.round(v * 100); vol.style.setProperty("--p", v * 100 + "%"); store.set("volume", v); }
vol.addEventListener("input", () => setVolume(vol.value / 100));
setVolume(store.get("volume", 1));

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.code === "Escape") { if (!$("#eq-sheet").hidden) eqClose(); else closeNow(); }
});

// полноэкранный плеер
function openNow() { if (state.index < 0) return; $("#now").hidden = false; }
function closeNow() { $("#now").hidden = true; }
$("#p-open").addEventListener("click", () => { if (window.matchMedia("(max-width: 860px)").matches) openNow(); });
$("#p-expand").addEventListener("click", openNow);
$("#now-close").addEventListener("click", closeNow);
$("#now-save").addEventListener("click", (e) => { const t = state.queue[state.index]; if (t) saveToPc(t, e.currentTarget); });
// свайп вниз — свернуть
(function swipe() {
  let y0 = null;
  $("#now").addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  $("#now").addEventListener("touchend", (e) => {
    if (y0 != null && e.changedTouches[0].clientY - y0 > 90 && !e.target.closest(".range")) closeNow();
    y0 = null;
  });
})();

// ---------- эквалайзер ----------
const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_LABELS = ["32", "64", "125", "250", "500", "1к", "2к", "4к", "8к", "16к"];
const EQ_PRESETS = {
  bass:      { name: "Больше басов", g: [7, 6, 4.5, 2, 0, 0, 0, 0, 0, 0] },
  superbass: { name: "Супер бас",    g: [10, 9, 6.5, 3, 0, -1, 0, 0, 0, 0] },
  rap:       { name: "Рэп",          g: [6, 5.5, 3, 1, -1, -1, 1, 0.5, 1, 2] },
  vshape:    { name: "Басы и верха", g: [6, 5, 3, 0, -1.5, -1.5, 0, 2, 4, 5] },
  vocal:     { name: "Вокал",        g: [-2, -2, -1, 1, 3, 4, 3, 2, 0, -1] },
  rock:      { name: "Рок",          g: [5, 4, 2, -1, -2, -1, 2, 3, 4, 4] },
  edm:       { name: "Электроника",  g: [6, 5, 2, 0, -2, 1, 0, 2, 4, 5] },
  treble:    { name: "Больше верхов", g: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  flat:      { name: "Ровно",        g: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
};
const eq = {
  ctx: null, pre: null, filters: [],
  on: store.get("eq-on", false),
  preset: store.get("eq-preset", "bass"),
  gains: store.get("eq-gains", EQ_PRESETS.bass.g.slice()),
};

function eqGraph() {
  // Аудиограф создаём только когда эквалайзер нужен и только по действию пользователя (иначе браузер его «усыпит»)
  if (eq.ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try {
    const ctx = new AC();
    const src = ctx.createMediaElementSource(audio);
    const pre = ctx.createGain();
    const filters = EQ_BANDS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
      b.frequency.value = f;
      b.Q.value = 1.1;
      return b;
    });
    const limiter = ctx.createDynamicsCompressor();   // чтобы громкие басы не хрипели
    limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.2;
    let node = src.connect(pre);
    for (const f of filters) node = node.connect(f);
    node.connect(limiter).connect(ctx.destination);
    Object.assign(eq, { ctx, pre, filters });
    return true;
  } catch (e) {
    console.warn("Эквалайзер недоступен:", e);
    return false;
  }
}
function eqApply() {
  if (!eq.ctx) { if (!eq.on || !eqGraph()) return; }
  const g = eq.on ? eq.gains : EQ_BANDS.map(() => 0);
  const t = eq.ctx.currentTime;
  eq.filters.forEach((f, i) => f.gain.setTargetAtTime(g[i], t, 0.04));
  const boost = Math.max(0, ...g);                         // запас по громкости под подъём частот
  eq.pre.gain.setTargetAtTime(Math.pow(10, (-boost * 0.45) / 20), t, 0.04);
  if (eq.ctx.state === "suspended") eq.ctx.resume().catch(() => {});
}
function eqBeforePlay() { if (eq.on || eq.ctx) eqApply(); }
audio.addEventListener("play", () => { if (eq.ctx && eq.ctx.state === "suspended") eq.ctx.resume().catch(() => {}); });

function eqSave() {
  store.set("eq-on", eq.on); store.set("eq-preset", eq.preset); store.set("eq-gains", eq.gains);
  const name = eq.preset === "custom" ? "Свой" : (EQ_PRESETS[eq.preset] || {}).name || "Свой";
  $("#eq-summary").textContent = eq.on ? `Включён · ${name}` : "Выключен";
  $("#eq-summary").className = "hint" + (eq.on ? " ok" : "");
  $$(".eq-btn").forEach((b) => b.classList.toggle("active", eq.on));
}
function eqRender() {
  $("#eq-on").checked = eq.on;
  const pbox = $("#eq-presets"); pbox.innerHTML = "";
  for (const [id, p] of Object.entries(EQ_PRESETS)) {
    pbox.append(el("button", { type: "button", class: "chip" + (eq.on && eq.preset === id ? " active" : ""), onclick: () => eqSetPreset(id) }, p.name));
  }
  if (eq.preset === "custom") pbox.append(el("button", { type: "button", class: "chip chip-custom" + (eq.on ? " active" : "") }, "Свой"));
  const bbox = $("#eq-bands"); bbox.innerHTML = "";
  bbox.classList.toggle("off", !eq.on);
  EQ_BANDS.forEach((_, i) => {
    const db = el("span", { class: "db" }, fmtDb(eq.gains[i]));
    const input = el("input", { type: "range", min: "-12", max: "12", step: "0.5", value: String(eq.gains[i]), "aria-label": `${EQ_LABELS[i]} Гц` });
    input.addEventListener("input", () => {
      eq.gains[i] = Number(input.value); db.textContent = fmtDb(eq.gains[i]);
      if (eq.preset !== "custom" || !eq.on) {
        eq.preset = "custom"; eq.on = true;
        $("#eq-on").checked = true; $("#eq-bands").classList.remove("off"); renderEqPresets();
      }
      eqApply(); eqSave();
    });
    bbox.append(el("div", { class: "band" }, db, input, el("span", { class: "hz" }, EQ_LABELS[i])));
  });
}
function renderEqPresets() {
  $$("#eq-presets .chip").forEach((c) => c.classList.remove("active"));
  if (eq.preset === "custom" && !$$("#eq-presets .chip-custom").length) {
    $("#eq-presets").append(el("button", { type: "button", class: "chip chip-custom active" }, "Свой"));
  }
  const c = $("#eq-presets .chip-custom"); if (c) c.classList.toggle("active", eq.preset === "custom");
}
function fmtDb(v) { return (v > 0 ? "+" : "") + (Number.isInteger(v) ? v : v.toFixed(1)); }
function eqSetPreset(id) {
  eq.preset = id; eq.gains = EQ_PRESETS[id].g.slice(); eq.on = true;
  eqApply(); eqSave(); eqRender();
}
function eqOpen() { eqRender(); $("#eq-sheet").hidden = false; }
function eqClose() { $("#eq-sheet").hidden = true; }

$$("[data-eq-open]").forEach((b) => b.addEventListener("click", eqOpen));
$("#eq-close").addEventListener("click", eqClose);
$("#eq-sheet").addEventListener("click", (e) => { if (e.target.id === "eq-sheet") eqClose(); });
$("#eq-on").addEventListener("change", (e) => { eq.on = e.target.checked; eqApply(); eqSave(); eqRender(); });
$("#eq-reset").addEventListener("click", () => eqSetPreset("flat"));
$("#eq-quick-bass").addEventListener("click", () => { eqSetPreset("bass"); toast("Эквалайзер: больше басов"); });
eqSave();

// ---------- очередь ----------
function renderQueue() {
  const box = $("#queue"); box.innerHTML = "";
  if (!state.queue.length) { box.append(el("div", { class: "empty" }, "Очередь пуста. Нажмите ＋ у любого трека.")); return; }
  state.queue.forEach((t, i) => {
    const rm = iconBtn("x", "Убрать", () => {
      state.queue.splice(i, 1);
      if (i < state.index) state.index--;
      else if (i === state.index && state.index >= state.queue.length) state.index = state.queue.length - 1;
      renderQueue(); updateQueueCount();
    });
    const row = trackRow(t, () => { state.index = i; playCurrent(); renderQueue(); }, [rm]);
    if (i === state.index) row.classList.add("playing");
    box.append(row);
  });
}
$("#clear-queue").addEventListener("click", () => { state.queue = []; state.index = -1; renderQueue(); updateQueueCount(); });

// ---------- скачанное ----------
async function loadLibrary() {
  const box = $("#library"); box.innerHTML = ""; box.append(skeleton(4));
  try {
    const s = await api("/api/settings");
    $("#lib-path").textContent = android ? "Треки сохраняются в папку «Музыка/MusicHub» на телефоне" : "Папка: " + s.download_dir;
    const files = await api("/api/library");
    box.innerHTML = "";
    if (!files.length) { box.append(el("div", { class: "empty" }, "Пока ничего не скачано. Нажмите ⬇ у любого трека.")); return; }
    const tracks = files.map((f) => ({ source: "file", id: f.name, key: "file:" + f.name, title: f.title, artist: f.artist }));
    tracks.forEach((t, i) => box.append(trackRow(t, () => playList(tracks, i))));
    highlight(state.queue[state.index]);
  } catch (err) { box.innerHTML = ""; box.append(el("div", { class: "alert" }, err.message)); }
}
$("#refresh-lib").addEventListener("click", loadLibrary);

// ---------- настройки ----------
async function loadSettings() {
  const s = await api("/api/settings");
  state.settings = s;
  for (const [k, v] of Object.entries(s)) { const i = $(`#settings-form [name="${k}"]`); if (i) i.value = v; }
  $("#uncensored").checked = s.uncensored !== "0" && s.uncensored !== "";
  checkYandex(Boolean(s.yandex_token));
  showSpotifyState(s);
  checkSpotify(Boolean(s.spotify_refresh_token));
}
$("#uncensored").addEventListener("change", async (e) => {
  try {
    await api("/api/settings", { json: { uncensored: e.target.checked ? "1" : "0" } });
    toast(e.target.checked ? "Сначала — версии без цензуры" : "Порядок как в сервисах");
    if ($("#q").value.trim() && $("#results").children.length) doSearch();
  } catch (err) { toast(err.message); }
});

// ---------- Spotify: вход и медиатека ----------
const spotifyRedirect = `http://127.0.0.1:${location.port || 80}/api/spotify/callback`;
$("#sp-redirect").textContent = spotifyRedirect;
$("#sp-remote").hidden = isLocal || Boolean(android);

function showSpotifyState(s) {
  const logged = Boolean(s.spotify_refresh_token);
  $("#sp-library").hidden = !logged;
  $$("[data-sp-only]").forEach((n) => (n.hidden = !logged));
  $("#sp-logout").hidden = !logged;
  $("#sp-login").textContent = logged ? "Войти заново" : "Войти через Spotify";
  if (!s.spotify_client_id && !logged) $("#sp-help").open = true;
}

async function checkSpotify(logged) {
  const st = $("#sp-status");
  st.className = "hint";
  if (!logged) { st.textContent = "Вход не выполнен"; return; }
  st.textContent = "Проверяю вход…";
  try {
    const r = await api("/api/spotify/status");
    st.className = "hint ok";
    st.textContent = `Вы вошли как ${r.name || "пользователь Spotify"}`;
  } catch (err) { st.className = "hint bad"; st.textContent = err.message; }
}

$("#sp-login").addEventListener("click", async () => {
  const input = $("#settings-form [name=spotify_client_id]");
  const id = input.value.trim();
  if (!id) { $("#sp-help").open = true; input.focus(); toast("Сначала вставьте Client ID — см. инструкцию"); return; }
  try { await api("/api/settings", { json: { spotify_client_id: id } }); } catch (err) { toast(err.message); return; }
  location.href = "/api/spotify/login";   // страница входа Spotify, затем возврат в приложение
});
$("#sp-logout").addEventListener("click", async () => {
  await api("/api/spotify/logout", { json: {} });
  toast("Вы вышли из Spotify");
  loadSettings(); loadSources();
});
$("#sp-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(spotifyRedirect); toast("Скопировано"); } catch { toast(spotifyRedirect); }
});

async function showSpotifyLiked() {
  showTab("search");
  startLoading("Загружаю «Любимые треки»…");
  try {
    const data = await api("/api/spotify/liked");
    renderResults(data);
    $("#status").textContent = `Любимые треки Spotify: ${data.results.spotify.length}`;
  } catch (err) { $("#results").innerHTML = ""; $("#status").textContent = ""; $("#results").append(el("div", { class: "alert" }, err.message)); }
}
async function showSpotifyPlaylists() {
  showTab("search");
  startLoading("Загружаю плейлисты…");
  const box = $("#results");
  try {
    const list = await api("/api/spotify/playlists");
    box.innerHTML = "";
    $("#status").textContent = list.length ? `Плейлисты Spotify: ${list.length}` : "Плейлистов нет";
    for (const p of list) {
      box.append(el("div", { class: "playlist", onclick: () => openPlaylist(p) },
        el("div", { class: "art" }, p.image ? el("img", { src: p.image, loading: "lazy", alt: "" }) : icon("playlist")),
        el("div", {}, el("div", { class: "t" }, p.name),
          el("div", { class: "a" }, [p.owner, p.count != null ? `${p.count} треков` : ""].filter(Boolean).join(" · ")))));
    }
  } catch (err) { box.innerHTML = ""; $("#status").textContent = ""; box.append(el("div", { class: "alert" }, err.message)); }
}
async function openPlaylist(p) {
  startLoading(`Загружаю «${p.name}»…`);
  try {
    const data = await api(`/api/spotify/playlist/${encodeURIComponent(p.id)}`);
    renderResults(data);
    $("#status").textContent = `${p.name}: ${data.results.spotify.length} треков`;
  } catch (err) { $("#results").innerHTML = ""; $("#status").textContent = ""; $("#results").append(el("div", { class: "alert" }, err.message)); }
}
$$("[data-sp-liked]").forEach((b) => b.addEventListener("click", showSpotifyLiked));
$$("[data-sp-playlists]").forEach((b) => b.addEventListener("click", showSpotifyPlaylists));

// возврат со страницы входа Spotify
(function handleSpotifyReturn() {
  const q = new URLSearchParams(location.search);
  if (!q.has("spotify") && !q.has("spotify_error")) return;
  history.replaceState(null, "", "/");
  if (q.get("spotify") === "ok") toast("Вход в Spotify выполнен");
  else { toast(q.get("spotify_error")); setTimeout(() => showTab("settings"), 0); }
})();

// ---------- вход в Яндекс ----------
// официальный клиент Яндекс Музыки — через него работает библиотека yandex-music
const YANDEX_OAUTH_URL = "https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d";

async function checkYandex(hasToken) {
  const st = $("#ya-status");
  $("#ya-logout").hidden = !hasToken;
  $("#ya-login").textContent = hasToken ? "Войти заново" : "Войти через Яндекс";
  st.className = "hint";
  if (!hasToken) { st.textContent = "Вход не выполнен"; return; }
  st.textContent = "Проверяю вход…";
  try {
    const a = await api("/api/yandex/account");
    st.className = "hint ok";
    st.textContent = `Вы вошли как ${a.name || a.login || "пользователь Яндекса"}` +
      (a.plus ? " · Плюс ✓" : " · без Плюса: только 30-секундные отрывки");
  } catch (err) { st.className = "hint bad"; st.textContent = err.message; }
}

async function onYandexToken(token) {
  try {
    await api("/api/settings", { json: { yandex_token: token } });
    $("#ya-manual").hidden = true;
    toast("Вход в Яндекс выполнен");
    await loadSettings();
    loadSources();
  } catch (err) { toast(err.message); }
}

$("#ya-login").addEventListener("click", async () => {
  if (android && android.yandexLogin) { android.yandexLogin(); return; }   // Android-приложение
  if (window.pywebview && window.pywebview.api && window.pywebview.api.yandex_login) {   // MusicHub.exe
    toast("Войдите в открывшемся окне");
    const token = await window.pywebview.api.yandex_login();
    if (token) onYandexToken(token); else toast("Вход отменён");
    return;
  }
  window.open(YANDEX_OAUTH_URL, "_blank");                                  // обычный браузер
  $("#ya-manual").hidden = false;
  const input = $("#settings-form [name=yandex_token]");
  input.closest("details").open = true;
  input.type = "text";
});
$("#ya-logout").addEventListener("click", async () => {
  await api("/api/settings", { json: { yandex_token: "" } });
  toast("Вы вышли из Яндекса");
  await loadSettings();
  loadSources();
});

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target).entries());
  try {
    await api("/api/settings", { json: values });
    $("#settings-status").textContent = "Сохранено ✓";
    setTimeout(() => ($("#settings-status").textContent = ""), 2500);
    $("#ya-manual").hidden = true;
    loadSettings();
    loadSources();
  } catch (err) { $("#settings-status").textContent = err.message; }
});

// ---------- старт ----------
renderRecent();
onPlayState();
loadSources().catch((err) => ($("#status").textContent = err.message));
api("/api/settings").then((s) => { state.settings = s; showSpotifyState(s); }).catch(() => {});
// вход мог завершиться в другом окне/браузере — обновим состояние при возвращении в приложение
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") api("/api/settings").then(showSpotifyState).catch(() => {});
});
if ("serviceWorker" in navigator && (location.protocol === "https:" || isLocal)) navigator.serviceWorker.register("/sw.js");
