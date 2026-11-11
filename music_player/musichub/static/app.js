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
function showTab(name) { document.querySelector(`nav button[data-tab="${name}"]`).click(); }
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
      el("div", { class: "a" }, el("span", { class: "badge b-" + t.source }, SOURCE_NAMES[t.source] || t.source),
        t.protected ? el("span", { class: "badge b-lock", title: "Источник закрыл звук (DRM или только отрывок) — найдём этот трек в других сервисах" }, "🔒 замена") : null,
        t.artist || "")),
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
    let src, via = null;
    if (t.source === "file") src = `/api/library/${encodeURIComponent(t.id)}`;
    else { const r = await api("/api/prepare", { json: t }); src = r.audio; via = r.via_title; }
    if (token !== playToken) return;           // пользователь уже включил другой трек
    audio.src = src.startsWith("/api/library/") ? src : encodeURI(src);
    $("#p-artist").textContent = (t.artist || "") + (via ? ` · звук: ${via}` : "");
    await audio.play();
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
  checkYandex(Boolean(s.yandex_token));
  showSpotifyState(s);
  checkSpotify(Boolean(s.spotify_refresh_token));
}

// ---------- Spotify: вход и медиатека ----------
const spotifyRedirect = `http://127.0.0.1:${location.port || 80}/api/spotify/callback`;
$("#sp-redirect").textContent = spotifyRedirect;
$("#sp-remote").hidden = isLocal || Boolean(window.MusicHubAndroid);

function showSpotifyState(s) {
  const logged = Boolean(s.spotify_refresh_token);
  $("#sp-library").hidden = !logged;
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
  try {
    await api("/api/settings", { json: { spotify_client_id: id } });
  } catch (err) { toast(err.message); return; }
  location.href = "/api/spotify/login";   // страница входа Spotify, затем возврат в приложение
});
$("#sp-logout").addEventListener("click", async () => {
  await api("/api/spotify/logout", { json: {} });
  toast("Вы вышли из Spotify");
  loadSettings(); loadSources();
});
$("#sp-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(spotifyRedirect); toast("Скопировано"); }
  catch { toast(spotifyRedirect); }
});

$("#sp-liked").addEventListener("click", async () => {
  $("#status").textContent = "Загружаю «Любимые треки»…"; $("#results").innerHTML = "";
  try {
    const data = await api("/api/spotify/liked");
    renderResults(data);
    $("#status").textContent = `Любимые треки Spotify: ${data.results.spotify.length}`;
  } catch (err) { $("#status").textContent = err.message; }
});
$("#sp-playlists").addEventListener("click", async () => {
  $("#status").textContent = "Загружаю плейлисты…";
  const box = $("#results"); box.innerHTML = "";
  try {
    const list = await api("/api/spotify/playlists");
    $("#status").textContent = list.length ? `Плейлисты Spotify: ${list.length}` : "Плейлистов нет";
    for (const p of list) {
      box.append(el("div", { class: "playlist", onclick: () => openPlaylist(p) },
        p.image ? el("img", { src: p.image, loading: "lazy", alt: "" }) : el("div", { class: "noart" }),
        el("div", { class: "meta" }, el("div", { class: "t" }, p.name),
          el("div", { class: "a" }, [p.owner, p.count != null ? `${p.count} треков` : ""].filter(Boolean).join(" · ")))));
    }
  } catch (err) { $("#status").textContent = err.message; }
});
async function openPlaylist(p) {
  $("#status").textContent = `Загружаю «${p.name}»…`; $("#results").innerHTML = "";
  try {
    const data = await api(`/api/spotify/playlist/${encodeURIComponent(p.id)}`);
    renderResults(data);
    $("#status").textContent = `${p.name}: ${data.results.spotify.length} треков`;
  } catch (err) { $("#status").textContent = err.message; }
}

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
      (a.plus ? " · Плюс ✓" : " · без Плюса: будут только 30-секундные отрывки");
  } catch (err) {
    st.className = "hint bad";
    st.textContent = err.message;
  }
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
  if (window.MusicHubAndroid && window.MusicHubAndroid.yandexLogin) {      // Android-приложение
    window.MusicHubAndroid.yandexLogin();
    return;
  }
  if (window.pywebview && window.pywebview.api && window.pywebview.api.yandex_login) {   // MusicHub.exe
    toast("Войдите в открывшемся окне");
    const token = await window.pywebview.api.yandex_login();
    if (token) onYandexToken(token); else toast("Вход отменён");
    return;
  }
  window.open(YANDEX_OAUTH_URL, "_blank");                                  // обычный браузер
  $("#ya-manual").hidden = false;
  $("#settings-form [name=yandex_token]").type = "text";
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
    $("#ya-manual").hidden = true;
    loadSettings();
    loadSources();
  } catch (err) { $("#settings-status").textContent = err.message; }
});

loadSources().catch((err) => ($("#status").textContent = err.message));
api("/api/settings").then(showSpotifyState).catch(() => {});
// вход мог завершиться в другом окне/браузере — обновим состояние при возвращении в приложение
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") api("/api/settings").then(showSpotifyState).catch(() => {});
});
if ("serviceWorker" in navigator && (location.protocol === "https:" || isLocal)) navigator.serviceWorker.register("/sw.js");
