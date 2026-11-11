"use strict";
const $ = (s) => document.querySelector(s);
const audio = $("#audio");
const isLocal = ["127.0.0.1", "localhost"].includes(location.hostname);
const SOURCE_NAMES = { all: "Все", yandex: "Яндекс", soundcloud: "SoundCloud", spotify: "Spotify", youtube: "YouTube", file: "Файл" };
const state = { sources: [], filter: "all", queue: [], index: -1, lastResults: null };

// ---------- утилиты ----------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}
function fmt(sec) {
  if (!sec || !isFinite(sec)) return "0:00";
  sec = Math.floor(sec);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
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

// ---------- вкладки ----------
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
  if (b.dataset.tab === "library") loadLibrary();
  if (b.dataset.tab === "settings") loadSettings();
  if (b.dataset.tab === "queue") renderQueue();
}));

// ---------- источники и поиск ----------
async function loadSources() {
  state.sources = await api("/api/sources");
  const box = $("#source-filter"); box.innerHTML = "";
  for (const s of [{ name: "all", title: "Все", available: true }, ...state.sources]) {
    box.append(el("button", {
      class: "chip" + (s.name === state.filter ? " active" : "") + (s.available ? "" : " off"),
      title: s.available ? "" : "Не настроено — откройте «Настройки»",
      onclick: () => { state.filter = s.name; loadSources(); if ($("#q").value.trim()) doSearch(); },
    }, s.title));
  }
}

$("#search-form").addEventListener("submit", (e) => { e.preventDefault(); doSearch(); });

async function doSearch() {
  const q = $("#q").value.trim();
  if (!q) return;
  $("#status").textContent = "Ищу…"; $("#results").innerHTML = "";
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&source=${state.filter}`);
    state.lastResults = data;
    renderResults(data);
    const n = Object.values(data.results).reduce((a, l) => a + l.length, 0);
    $("#status").textContent = n ? `Найдено: ${n}` : "Ничего не найдено";
  } catch (err) { $("#status").textContent = err.message; }
}

function renderResults(data) {
  const box = $("#results"); box.innerHTML = "";
  const order = ["yandex", "soundcloud", "spotify", "youtube"];
  for (const src of order) {
    const list = data.results[src], error = data.errors[src];
    if (!(list && list.length) && !error) continue;
    box.append(el("h3", {}, SOURCE_NAMES[src] || src));
    if (error) box.append(el("div", { class: "error" }, error));
    (list || []).forEach((t, i) => box.append(trackRow(t, () => playList(list, i))));
  }
}

function trackRow(t, onPlay, extraActs = []) {
  const art = t.artwork ? el("img", { src: t.artwork, loading: "lazy", alt: "" }) : el("div", { class: "noart" });
  const acts = [
    el("button", { title: "В очередь", onclick: () => { state.queue.push(t); toast("Добавлено в очередь"); } }, "＋"),
    el("button", { title: "Скачать на компьютер", onclick: (e) => saveToPc(t, e.currentTarget) }, "⬇"),
  ];
  if (!isLocal && !window.MusicHubAndroid) acts.push(el("button", { title: "Скачать на это устройство", onclick: (e) => saveToDevice(t, e.currentTarget) }, "📱"));
  const row = el("div", { class: "track", "data-key": t.key || "" },
    art,
    el("div", { class: "meta", onclick: onPlay },
      el("div", { class: "t" }, t.title),
      el("div", { class: "a" }, el("span", { class: "badge b-" + t.source }, SOURCE_NAMES[t.source] || t.source), t.artist || "")),
    el("div", { class: "dur" }, t.duration ? fmt(t.duration) : ""),
    el("div", { class: "acts" }, ...extraActs, ...acts));
  return row;
}

// ---------- скачивание ----------
async function saveToPc(t, btn) {
  if (window.MusicHubAndroid) return saveToDevice(t, btn);   // в Android-приложении ⬇ = в «Музыку» телефона
  btn.disabled = true; const old = btn.textContent; btn.textContent = "…";
  try {
    const r = await api("/api/download", { json: t });
    toast("Сохранено: " + r.path); btn.textContent = "✓";
  } catch (err) { toast(err.message); btn.textContent = old; }
  btn.disabled = false;
}
async function saveToDevice(t, btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = "…";
  try {
    if (t.source === "file") {
      const url = `/api/library/${encodeURIComponent(t.id)}?attachment=true`;
      if (window.MusicHubAndroid) window.MusicHubAndroid.download(url, t.id.replace(/\.[^.]+$/, ""));
      else location.href = url;
      return;
    }
    const r = await api("/api/prepare", { json: t });
    const url = "/api/file/" + encodeURI(r.key);
    if (window.MusicHubAndroid) { window.MusicHubAndroid.download(url, (t.artist ? t.artist + " - " : "") + t.title); toast("Скачиваю в «Музыка/MusicHub»…"); }
    else location.href = url;
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = old; }
}

// ---------- плеер ----------
function playList(list, i) { state.queue = list.slice(); state.index = i; playCurrent(); }

let playToken = 0;
async function playCurrent() {
  const t = state.queue[state.index];
  if (!t) return;
  const token = ++playToken;
  $("#p-title").textContent = t.title; $("#p-artist").textContent = "Загрузка…";
  $("#p-art").src = t.artwork || "/static/icon.svg";
  $("#p-play").textContent = "⏳";
  highlight(t);
  try {
    let src;
    if (t.source === "file") src = `/api/library/${encodeURIComponent(t.id)}`;
    else src = (await api("/api/prepare", { json: t })).audio;
    if (token !== playToken) return;           // пользователь уже включил другой трек
    audio.src = src.startsWith("/api/library/") ? src : encodeURI(src);
    await audio.play();
    $("#p-artist").textContent = t.artist || "";
    setMediaSession(t);
    prefetchNext();
  } catch (err) {
    if (token !== playToken) return;
    $("#p-artist").textContent = ""; $("#p-play").textContent = "▶";
    toast(err.message);
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
function highlight(t) {
  document.querySelectorAll(".track.playing").forEach((n) => n.classList.remove("playing"));
  if (t.key) document.querySelectorAll(`.track[data-key="${CSS.escape(t.key)}"]`).forEach((n) => n.classList.add("playing"));
}
function setMediaSession(t) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist || "", artwork: t.artwork ? [{ src: t.artwork, sizes: "400x400" }] : [],
  });
  navigator.mediaSession.setActionHandler("previoustrack", prev);
  navigator.mediaSession.setActionHandler("nexttrack", next);
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
}

$("#p-play").addEventListener("click", () => {
  if (!audio.src) { if (state.queue.length) { state.index = Math.max(state.index, 0); playCurrent(); } return; }
  audio.paused ? audio.play() : audio.pause();
});
$("#p-next").addEventListener("click", next);
$("#p-prev").addEventListener("click", prev);
audio.addEventListener("play", () => ($("#p-play").textContent = "⏸"));
audio.addEventListener("pause", () => ($("#p-play").textContent = "▶"));
audio.addEventListener("ended", next);
audio.addEventListener("timeupdate", () => {
  $("#p-cur").textContent = fmt(audio.currentTime);
  $("#p-dur").textContent = fmt(audio.duration);
  if (audio.duration && !seeking) $("#p-bar").value = (audio.currentTime / audio.duration) * 1000;
});
let seeking = false;
$("#p-bar").addEventListener("input", () => (seeking = true));
$("#p-bar").addEventListener("change", (e) => {
  if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration;
  seeking = false;
});
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target.tagName !== "INPUT") { e.preventDefault(); $("#p-play").click(); }
});

// ---------- очередь ----------
function renderQueue() {
  const box = $("#queue"); box.innerHTML = "";
  if (!state.queue.length) { box.append(el("p", { class: "hint" }, "Очередь пуста")); return; }
  state.queue.forEach((t, i) => {
    const rm = el("button", { title: "Убрать", onclick: () => {
      state.queue.splice(i, 1); if (i < state.index) state.index--; renderQueue();
    } }, "✕");
    const row = trackRow(t, () => { state.index = i; playCurrent(); }, [rm]);
    if (i === state.index) row.classList.add("playing");
    box.append(row);
  });
}
$("#clear-queue").addEventListener("click", () => { state.queue = []; state.index = -1; renderQueue(); });

// ---------- скачанное ----------
async function loadLibrary() {
  const box = $("#library"); box.innerHTML = "";
  try {
    const s = await api("/api/settings");
    $("#lib-path").textContent = "Папка: " + s.download_dir;
    const files = await api("/api/library");
    if (!files.length) { box.append(el("p", { class: "hint" }, "Пока ничего не скачано")); return; }
    const tracks = files.map((f) => ({ source: "file", id: f.name, key: "file:" + f.name, title: f.title, artist: f.artist }));
    tracks.forEach((t, i) => box.append(trackRow(t, () => playList(tracks, i))));
  } catch (err) { box.append(el("div", { class: "error" }, err.message)); }
}
$("#refresh-lib").addEventListener("click", loadLibrary);

// ---------- настройки ----------
async function loadSettings() {
  const s = await api("/api/settings");
  for (const [k, v] of Object.entries(s)) { const i = $(`#settings-form [name="${k}"]`); if (i) i.value = v; }
}
$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target).entries());
  try {
    await api("/api/settings", { json: values });
    $("#settings-status").textContent = "Сохранено ✓";
    loadSources();
  } catch (err) { $("#settings-status").textContent = err.message; }
});

loadSources().catch((err) => ($("#status").textContent = err.message));
if ("serviceWorker" in navigator && (location.protocol === "https:" || isLocal)) navigator.serviceWorker.register("/sw.js");
