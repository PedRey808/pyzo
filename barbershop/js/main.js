/* =========================================================
   КЛИНОК — motion scripts (vanilla JS, без зависимостей)
   ========================================================= */
(() => {
  "use strict";

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const desktopMQ = window.matchMedia("(min-width: 901px)");

  /* ---------- Разбивка текста на буквы ---------- */
  $$("[data-split]").forEach((el) => {
    const text = el.textContent;
    el.textContent = "";
    [...text].forEach((ch, i) => {
      const span = document.createElement("span");
      span.className = "char";
      span.style.setProperty("--i", i);
      if (ch === " " || ch === " ") {
        span.classList.add("char--space");
        span.innerHTML = "&nbsp;";
      } else {
        span.textContent = ch;
      }
      el.appendChild(span);
    });
  });

  /* ---------- Разбивка абзаца на слова ---------- */
  const aboutWords = [];
  $$(".reveal-words").forEach((el) => {
    const words = el.textContent.split(/(\s+)/);
    el.textContent = "";
    words.forEach((w) => {
      if (/^\s+$/.test(w)) { el.appendChild(document.createTextNode(" ")); return; }
      const span = document.createElement("span");
      span.className = "word";
      span.textContent = w;
      el.appendChild(span);
      aboutWords.push(span);
    });
  });

  /* ---------- Появление по скроллу ---------- */
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-in");
      if (entry.target.hasAttribute("data-counter")) runCounter(entry.target);
      io.unobserve(entry.target);
    });
  }, { threshold: 0.18, rootMargin: "0px 0px -6% 0px" });

  const observeAll = () => {
    $$(".reveal-up, .master, [data-counter]").forEach((el) => {
      if (!el.closest(".hero")) io.observe(el);
    });
    $$(".split").forEach((el) => { if (!el.closest(".hero")) io.observe(el); });
  };

  /* ---------- Счётчики ---------- */
  function runCounter(el) {
    const target = parseFloat(el.dataset.counter);
    const decimals = parseInt(el.dataset.decimals || "0", 10);
    const format = el.hasAttribute("data-format");
    const duration = reduceMotion ? 1 : 1800;
    const start = performance.now();
    const fmt = (v) => {
      const s = v.toFixed(decimals);
      return format ? Number(s).toLocaleString("ru-RU") : s.replace(".", ",");
    };
    const tick = (now) => {
      const t = clamp((now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      el.textContent = fmt(target * eased);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ---------- Прелоадер ---------- */
  const preloader = $(".preloader");
  const countEl = $("[data-count]");
  const hero = $(".hero");

  function startHero() {
    hero.classList.add("is-in");
    $$(".split", hero).forEach((el, i) => {
      setTimeout(() => el.classList.add("is-in"), i * 140);
    });
    $$(".reveal-up", hero).forEach((el) => el.classList.add("is-in"));
  }

  function finishLoading() {
    preloader.classList.add("is-done");
    setTimeout(() => {
      preloader.classList.add("is-gone");
      document.body.classList.remove("is-loading");
      startHero();
      observeAll();
    }, reduceMotion ? 0 : 750);
    setTimeout(() => preloader.remove(), reduceMotion ? 50 : 2000);
  }

  (function runPreloader() {
    const minTime = reduceMotion ? 0 : 1500;
    const t0 = performance.now();
    let loaded = false;
    const markLoaded = () => { loaded = true; };
    Promise.race([
      Promise.all([
        new Promise((r) => (document.readyState === "complete" ? r() : window.addEventListener("load", r, { once: true }))),
        document.fonts ? document.fonts.ready : Promise.resolve(),
      ]),
      new Promise((r) => setTimeout(r, 3500)),
    ]).then(markLoaded);

    let shown = 0;
    const tick = (now) => {
      const timeP = minTime ? clamp((now - t0) / minTime) : 1;
      const goal = loaded ? 100 : Math.min(92, timeP * 100);
      shown = lerp(shown, Math.max(goal * timeP, shown), 0.18);
      if (loaded && timeP >= 1 && shown > 99.4) shown = 100;
      countEl.textContent = Math.round(shown);
      if (shown >= 100) { finishLoading(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();

  /* ---------- Мобильное меню ---------- */
  const burger = $(".burger");
  const menu = $(".mobile-menu");
  const setMenu = (open) => {
    document.body.classList.toggle("menu-open", open);
    burger.setAttribute("aria-expanded", String(open));
    burger.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
    menu.setAttribute("aria-hidden", String(!open));
  };
  burger.addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
  $$("a", menu).forEach((a) => a.addEventListener("click", () => setMenu(false)));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
  desktopMQ.addEventListener("change", (e) => { if (e.matches) setMenu(false); });

  /* ---------- Фильтр услуг ---------- */
  const tabs = $$(".tab");
  const prices = $$(".price");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => { t.classList.toggle("is-active", t === tab); t.setAttribute("aria-selected", String(t === tab)); });
      const f = tab.dataset.filter;
      let n = 0;
      prices.forEach((p) => {
        const show = f === "all" || p.dataset.cat === f;
        p.classList.toggle("is-filtered", !show);
        if (show) {
          p.classList.add("is-entering");
          const delay = n++ * 60;
          requestAnimationFrame(() => setTimeout(() => p.classList.remove("is-entering"), delay + 20));
        }
      });
    });
  });

  /* ---------- Горизонтальный скролл «Ритуала» ---------- */
  const process = $(".process");
  const track = $(".process__track");
  const processBar = $(".process__bar span");
  let processDistance = 0;

  function layoutProcess() {
    if (desktopMQ.matches && !reduceMotion) {
      processDistance = Math.max(0, track.scrollWidth - window.innerWidth);
      process.style.height = `${processDistance + window.innerHeight}px`;
    } else {
      processDistance = 0;
      process.style.height = "";
      track.style.transform = "";
    }
  }
  track.addEventListener("scroll", () => {
    if (desktopMQ.matches) return;
    const max = track.scrollWidth - track.clientWidth;
    processBar.style.transform = `scaleX(${max > 0 ? track.scrollLeft / max : 0})`;
  }, { passive: true });

  /* ---------- Скролл-цикл ---------- */
  const header = $(".header");
  const progress = $(".scroll-progress");
  const marquee = $(".marquee");
  const biglines = $$(".bigline__row");
  const aboutText = $(".about__text");
  const fab = $(".fab");
  const booking = $("#booking");
  const shapes = $$(".shape");

  let lastY = window.scrollY;
  let velocity = 0;
  let skew = 0;
  let mouseX = 0, mouseY = 0, shapeX = 0, shapeY = 0;

  function onFrame() {
    const y = window.scrollY;
    const vh = window.innerHeight;
    const docH = document.documentElement.scrollHeight - vh;

    // прогресс страницы
    progress.style.transform = `scaleX(${docH > 0 ? y / docH : 0})`;

    // шапка
    const delta = y - lastY;
    header.classList.toggle("is-scrolled", y > 20);
    if (!document.body.classList.contains("menu-open")) {
      if (delta > 4 && y > 300) header.classList.add("is-hidden");
      else if (delta < -4) header.classList.remove("is-hidden");
    }

    // скорость скролла → наклон бегущей строки
    velocity = lerp(velocity, delta, 0.2);
    skew = lerp(skew, clamp(velocity * -0.4, -14, 14), 0.15);
    if (!reduceMotion) marquee.style.setProperty("--skew", `${skew.toFixed(2)}deg`);
    lastY = y;

    if (!reduceMotion) {
      // большие строки движутся в разные стороны
      biglines.forEach((row) => {
        const rect = row.getBoundingClientRect();
        if (rect.bottom < -100 || rect.top > vh + 100) return;
        const dir = parseFloat(row.dataset.direction);
        const shift = (rect.top - vh) * 0.45 * dir - (dir > 0 ? 0 : row.scrollWidth * 0.35);
        row.style.transform = `translate3d(${shift}px,0,0)`;
      });

      // слова подсвечиваются по мере прокрутки
      const ar = aboutText.getBoundingClientRect();
      if (ar.top < vh && ar.bottom > 0) {
        const p = clamp((vh * 0.85 - ar.top) / (ar.height + vh * 0.25));
        const lit = Math.round(p * aboutWords.length);
        aboutWords.forEach((w, i) => w.classList.toggle("is-lit", i < lit));
      }

      // горизонтальный трек
      if (processDistance > 0) {
        const pr = process.getBoundingClientRect();
        const p = clamp(-pr.top / (pr.height - vh));
        track.style.transform = `translate3d(${-p * processDistance}px,0,0)`;
        processBar.style.transform = `scaleX(${p})`;
      }

      // параллакс фигур в hero
      shapeX = lerp(shapeX, mouseX, 0.06);
      shapeY = lerp(shapeY, mouseY, 0.06);
      if (y < vh) {
        shapes.forEach((s) => {
          const d = parseFloat(s.dataset.depth || 0.5);
          s.style.transform = `translate3d(${shapeX * d * 40}px, ${shapeY * d * 40 + y * d * 0.25}px, 0)`;
        });
      }
    }

    // плавающая кнопка записи (мобильная)
    const br = booking.getBoundingClientRect();
    fab.classList.toggle("is-visible", y > vh * 0.6 && (br.top > vh || br.bottom < 0));

    requestAnimationFrame(onFrame);
  }

  window.addEventListener("mousemove", (e) => {
    mouseX = e.clientX / window.innerWidth - 0.5;
    mouseY = e.clientY / window.innerHeight - 0.5;
  }, { passive: true });

  /* ---------- Курсор, магнит, наклон ---------- */
  if (finePointer && !reduceMotion) {
    document.body.classList.add("has-cursor", "cursor-hidden");
    let seen = false;
    const cursor = $(".cursor");
    const dot = $(".cursor-dot");
    const label = $(".cursor__label");
    let cx = -100, cy = -100, tx = -100, ty = -100;

    window.addEventListener("mousemove", (e) => {
      tx = e.clientX; ty = e.clientY;
      if (!seen) { seen = true; cx = tx; cy = ty; document.body.classList.remove("cursor-hidden"); }
      dot.style.transform = `translate3d(${tx}px,${ty}px,0)`;
    }, { passive: true });
    document.addEventListener("mouseleave", () => document.body.classList.add("cursor-hidden"));
    document.addEventListener("mouseenter", () => document.body.classList.remove("cursor-hidden"));

    (function loop() {
      cx = lerp(cx, tx, 0.18); cy = lerp(cy, ty, 0.18);
      cursor.style.transform = `translate3d(${cx}px,${cy}px,0)`;
      requestAnimationFrame(loop);
    })();

    document.addEventListener("mouseover", (e) => {
      const target = e.target.closest("a, button, [data-cursor], .slider__viewport");
      cursor.classList.remove("is-hover", "is-label");
      label.textContent = "";
      if (!target) return;
      const text = target.dataset.cursor || (target.classList.contains("slider__viewport") ? "Drag" : "");
      if (text) { label.textContent = text; cursor.classList.add("is-label"); }
      else cursor.classList.add("is-hover");
    });

    $$(".magnetic").forEach((el) => {
      const strength = el.classList.contains("badge") ? 0.4 : 0.3;
      el.addEventListener("mousemove", (e) => {
        const r = el.getBoundingClientRect();
        const x = e.clientX - r.left - r.width / 2;
        const y = e.clientY - r.top - r.height / 2;
        el.style.transform = `translate(${x * strength}px, ${y * strength}px)`;
      });
      el.addEventListener("mouseleave", () => {
        el.style.transition = "transform .6s cubic-bezier(.16,1,.3,1)";
        el.style.transform = "";
        setTimeout(() => (el.style.transition = ""), 600);
      });
    });

    $$("[data-tilt]").forEach((card) => {
      const art = $(".master__art", card);
      card.addEventListener("mousemove", (e) => {
        const r = art.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        art.style.setProperty("--ry", `${px * 14}deg`);
        art.style.setProperty("--rx", `${py * -14}deg`);
      });
      card.addEventListener("mouseleave", () => {
        art.style.setProperty("--ry", "0deg");
        art.style.setProperty("--rx", "0deg");
      });
    });
  }

  /* ---------- Слайдер отзывов ---------- */
  const slider = $(".slider");
  const vp = $(".slider__viewport", slider);
  const sTrack = $(".slider__track", slider);
  const slides = $$(".review", slider);
  const dotsWrap = $(".slider__dots", slider);
  let index = 0;
  let autoplay;

  slides.forEach((_, i) => {
    const b = document.createElement("button");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-label", `Отзыв ${i + 1}`);
    b.addEventListener("click", () => { go(i); restart(); });
    dotsWrap.appendChild(b);
  });
  const dots = $$("button", dotsWrap);

  function offsetFor(i) {
    return slides[i].offsetLeft - slides[0].offsetLeft;
  }
  function go(i) {
    index = (i + slides.length) % slides.length;
    sTrack.style.transform = `translate3d(${-offsetFor(index)}px,0,0)`;
    slides.forEach((s, k) => s.classList.toggle("is-active", k === index));
    dots.forEach((d, k) => { d.classList.toggle("is-active", k === index); d.setAttribute("aria-selected", String(k === index)); });
  }
  function restart() {
    clearInterval(autoplay);
    if (!reduceMotion) autoplay = setInterval(() => go(index + 1), 5500);
  }
  $$(".slider__btn", slider).forEach((b) => b.addEventListener("click", () => { go(index + parseInt(b.dataset.dir, 10)); restart(); }));
  slider.addEventListener("mouseenter", () => clearInterval(autoplay));
  slider.addEventListener("mouseleave", restart);

  // свайп / драг
  let startX = 0, startY = 0, dragX = 0, dragging = false, decided = false, horizontal = false;
  vp.addEventListener("pointerdown", (e) => {
    dragging = true; decided = false; horizontal = false;
    startX = e.clientX; startY = e.clientY; dragX = 0;
    clearInterval(autoplay);
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!decided && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      decided = true; horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal) sTrack.classList.add("is-dragging");
    }
    if (!horizontal) return;
    dragX = dx;
    sTrack.style.transform = `translate3d(${-offsetFor(index) + dragX}px,0,0)`;
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    sTrack.classList.remove("is-dragging");
    if (horizontal && Math.abs(dragX) > 60) go(index + (dragX < 0 ? 1 : -1));
    else go(index);
    restart();
  };
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  /* ---------- Форма записи ---------- */
  const form = $(".form");
  const daysWrap = $(".days", form);
  const summary = $(".form__summary", form);
  const state = { service: "Мужская стрижка", master: "Любой", day: "", time: "14:00" };
  const weekdays = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const today = new Date();

  for (let i = 0; i < 10; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day" + (i === 0 ? " is-active" : "");
    b.dataset.value = `${d.getDate()} ${months[d.getMonth()]}`;
    b.dataset.seed = String(d.getDate() * 7 + d.getMonth());
    b.innerHTML = `<small>${i === 0 ? "сегодня" : i === 1 ? "завтра" : weekdays[d.getDay()]}</small><b>${d.getDate()}</b>`;
    daysWrap.appendChild(b);
  }
  state.day = $(".day", daysWrap).dataset.value;

  // «занятые» слоты: псевдослучайно, но стабильно для каждого дня
  function markBusy(seed) {
    const timeChips = $$(".chips--time .chip", form);
    timeChips.forEach((c, i) => c.classList.toggle("is-busy", ((seed + i * 13) % 5) === 0));
    const active = $(".chips--time .chip.is-active", form);
    if (!active || active.classList.contains("is-busy")) {
      timeChips.forEach((c) => c.classList.remove("is-active"));
      const free = timeChips.find((c) => !c.classList.contains("is-busy"));
      if (free) { free.classList.add("is-active"); state.time = free.dataset.value; }
    }
  }
  markBusy(parseInt($(".day", daysWrap).dataset.seed, 10));

  function updateSummary() {
    summary.innerHTML = `<b>${state.service}</b> · мастер: ${state.master}<br>${state.day}, ${state.time} · Рубинштейна, 17`;
  }
  updateSummary();

  $$(".chips", form).forEach((group) => {
    group.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip || chip.classList.contains("is-busy")) return;
      $$(".chip", group).forEach((c) => c.classList.toggle("is-active", c === chip));
      state[group.dataset.name] = chip.dataset.value;
      updateSummary();
    });
  });
  daysWrap.addEventListener("click", (e) => {
    const day = e.target.closest(".day");
    if (!day) return;
    $$(".day", daysWrap).forEach((d) => d.classList.toggle("is-active", d === day));
    state.day = day.dataset.value;
    markBusy(parseInt(day.dataset.seed, 10));
    updateSummary();
  });

  // при выборе мастера из карточки — подставляем его в форму
  $$(".master").forEach((card) => {
    card.addEventListener("click", () => {
      const first = $("h3", card).textContent.split(" ")[0];
      const chip = $$('[data-name="master"] .chip', form).find((c) => c.dataset.value === first);
      if (chip) chip.click();
      booking.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    });
  });

  // маска телефона
  const phone = form.elements.phone;
  phone.addEventListener("input", () => {
    let digits = phone.value.replace(/\D/g, "");
    if (digits.startsWith("8")) digits = "7" + digits.slice(1);
    if (!digits.startsWith("7")) digits = "7" + digits;
    digits = digits.slice(0, 11);
    const p = digits.slice(1);
    let out = "+7";
    if (p.length) out += " (" + p.slice(0, 3);
    if (p.length >= 3) out += ")";
    if (p.length > 3) out += " " + p.slice(3, 6);
    if (p.length > 6) out += "-" + p.slice(6, 8);
    if (p.length > 8) out += "-" + p.slice(8, 10);
    phone.value = out;
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = form.elements.name;
    const fields = [
      [name, name.value.trim().length >= 2],
      [phone, phone.value.replace(/\D/g, "").length === 11],
    ];
    let ok = true;
    fields.forEach(([input, valid]) => {
      const field = input.closest(".field");
      field.classList.remove("is-error");
      if (!valid) {
        ok = false;
        void field.offsetWidth; // перезапуск анимации тряски
        field.classList.add("is-error");
      }
    });
    if (!ok) { fields.find(([, v]) => !v)[0].focus(); return; }

    $(".form__success-text", form).textContent =
      `${name.value.trim()}, ждём вас ${state.day} в ${state.time}. ${state.service}, мастер — ${state.master === "Любой" ? "лучший из свободных" : state.master}. Подтверждение придёт по SMS.`;
    form.classList.add("is-sent");
    form.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  });

  $(".form__reset", form).addEventListener("click", () => {
    form.classList.remove("is-sent");
    form.elements.name.value = "";
    phone.value = "";
  });

  /* ---------- Старт ---------- */
  function onResize() {
    layoutProcess();
    go(index);
  }
  window.addEventListener("resize", onResize);
  desktopMQ.addEventListener("change", onResize);
  if (document.fonts) document.fonts.ready.then(onResize);
  onResize();
  restart();
  requestAnimationFrame(onFrame);
})();
