// CambioX UI. Plain ES modules, no build step: state → render().
import {
  AMOUNT_KEYS, RATE_KEYS, LIMITS, isValidRate, parseAmount, formatNumber, applyKey,
  formatEntry, entryFromNumber, convertAll, computeGap, parseRatesResponse,
  describeDate, timeAgo, shareText
} from "./core.js";

// One request returns both rates (BCV "oficial" and "paralelo").
const RATES_URL = "https://ve.dolarapi.com/v1/dolares";
const RATES_KEY = "cambiox:rates";
const AMOUNT_KEY = "cambiox:amount";
const LEGACY_KEYS = { bcv: "cambio-ve:bcv-rate", p2p: "cambio-ve:parallel-rate" };

const FETCH_TIMEOUT_MS = 8000;
const POLL_EVERY_MS = 10 * 60 * 1000; // while the app is open
const RESUME_AFTER_MS = 5 * 60 * 1000; // when it comes back to the foreground
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

const LABELS = { bs: "Bolívares", bcv: "Dólares BCV", p2p: "Dólares P2P", "rate:bcv": "Tasa BCV", "rate:p2p": "Tasa P2P" };
const SOURCE = { bcv: "Oficial", p2p: "Paralelo" };
const FIELD_ORDER = ["rate:bcv", "rate:p2p", "bs", "bcv", "p2p"];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ui = {
  status: $("#status"),
  statusText: $("#status-text"),
  refresh: $("#refresh-btn"),
  share: $("#share-btn"),
  install: $("#install-btn"),
  gap: $("#gap"),
  keypad: $(".keypad"),
  toast: $("#toast"),
  sr: $("#sr-summary"),
  fields: Object.fromEntries($$("[data-field]").map((node) => [node.dataset.field, node]))
};

const state = {
  active: "bs", // field the keypad types into
  entry: null, // raw text typed into the active field; null = value "selected", next key replaces it
  anchor: "bs", // amount the person typed last; it is never recalculated
  anchorValue: NaN,
  rates: { bcv: NaN, p2p: NaN }, // rates in use (from the API or typed by hand)
  api: { bcv: null, p2p: null }, // last { rate, date } from the API
  manual: { bcv: false, p2p: false },
  fetchedAt: 0,
  sync: "idle", // "loading" | "ok" | "error"
  inflight: null,
  forceQueued: false
};

const isRateField = (field) => field.startsWith("rate:");
const rateKeyOf = (field) => field.slice(5);

// ------------------------------------------------------------------ storage

const store = {
  read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / full */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
};

function migrateLegacyRates() {
  const saved = { fetchedAt: Infinity };
  for (const key of RATE_KEYS) {
    const old = store.read(LEGACY_KEYS[key]);
    if (old && isValidRate(Number(old.rate))) {
      saved[key] = { rate: Number(old.rate), date: old.sourceDate || null };
      saved.fetchedAt = Math.min(saved.fetchedAt, Number(old.fetchedAt) || 0);
    }
    store.remove(LEGACY_KEYS[key]);
  }
  if (!saved.bcv && !saved.p2p) return null;
  if (!Number.isFinite(saved.fetchedAt)) saved.fetchedAt = 0;
  store.write(RATES_KEY, saved);
  return saved;
}

function loadSaved() {
  const saved = store.read(RATES_KEY) || migrateLegacyRates();
  if (saved) {
    for (const key of RATE_KEYS) {
      const rate = Number(saved[key]?.rate);
      if (isValidRate(rate)) {
        state.api[key] = { rate, date: saved[key].date ?? null };
        state.rates[key] = rate;
      }
    }
    state.fetchedAt = Number(saved.fetchedAt) || 0;
  }

  const amount = store.read(AMOUNT_KEY);
  if (amount && AMOUNT_KEYS.includes(amount.anchor) && Number.isFinite(amount.value)) {
    state.anchor = amount.anchor;
    state.anchorValue = amount.value;
    state.active = amount.anchor;
  }
}

const saveRates = () => store.write(RATES_KEY, { bcv: state.api.bcv, p2p: state.api.p2p, fetchedAt: state.fetchedAt });

let saveAmountTimer;
function saveAmountSoon() {
  clearTimeout(saveAmountTimer);
  saveAmountTimer = setTimeout(() => {
    if (Number.isFinite(state.anchorValue)) store.write(AMOUNT_KEY, { anchor: state.anchor, value: state.anchorValue });
    else store.remove(AMOUNT_KEY);
  }, 400);
}

// ------------------------------------------------------------------ network

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function fetchRates(force) {
  // dolarapi.com sends an ETag with "max-age=0, must-revalidate", so the
  // browser's HTTP cache revalidates every request and gets a tiny 304 when
  // nothing changed. "no-cache" (refresh button) always asks the server,
  // even if those headers change one day.
  const response = await fetch(RATES_URL, {
    cache: force ? "no-cache" : "default",
    signal: timeoutSignal(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const parsed = parseRatesResponse(await response.json());
  if (!parsed.bcv && !parsed.p2p) throw new Error("La respuesta no trae tasas");
  return parsed;
}

/**
 * Refresh the rates. Automatic refreshes keep any rate typed by hand;
 * force=true (the ↻ button) replaces them with the day's rates.
 */
function loadRates({ force = false } = {}) {
  if (state.inflight) {
    state.forceQueued ||= force;
    return state.inflight;
  }

  state.sync = "loading";
  render();

  state.inflight = fetchRates(force)
    .then((parsed) => {
      const forced = force || state.forceQueued;
      for (const key of RATE_KEYS) {
        if (!parsed[key]) continue;
        state.api[key] = parsed[key];
        if (forced) {
          state.manual[key] = false;
          if (state.active === `rate:${key}`) state.entry = null;
        }
        if (!state.manual[key]) state.rates[key] = parsed[key].rate;
      }
      state.fetchedAt = Date.now();
      state.sync = "ok";
      saveRates();
      if (forced) toast("Tasas actualizadas");
    })
    .catch(() => {
      state.sync = "error";
      if (force || state.forceQueued) toast(navigator.onLine === false ? "Sin conexión" : "No se pudo actualizar");
    })
    .finally(() => {
      state.inflight = null;
      state.forceQueued = false;
      render();
    });

  return state.inflight;
}

// ------------------------------------------------------------------ editing

function press(key) {
  const field = state.active;
  const limits = isRateField(field) ? LIMITS.rate : LIMITS.amount;
  // A selected value is replaced by the first key (⌫ clears it).
  const next = applyKey(state.entry ?? "", key, limits);
  if (state.entry !== null && next === state.entry) return;

  state.entry = next;
  commit(field);
  if (navigator.vibrate) navigator.vibrate(8);
  render();
  announceSoon();
}

function commit(field) {
  const value = state.entry ? parseAmount(state.entry) : NaN;
  if (isRateField(field)) {
    const key = rateKeyOf(field);
    state.manual[key] = true;
    state.rates[key] = isValidRate(value) ? value : NaN;
  } else {
    state.anchor = field;
    state.anchorValue = value;
    saveAmountSoon();
  }
}

function activate(field) {
  if (state.active !== field) {
    const previous = state.active;
    // A rate left empty goes back to the day's rate.
    if (isRateField(previous) && state.manual[rateKeyOf(previous)] && !isValidRate(state.rates[rateKeyOf(previous)])) {
      resetRate(rateKeyOf(previous));
    }
    state.active = field;
  }
  state.entry = null; // tapping a field selects its value
  render();
}

function resetRate(key) {
  state.manual[key] = false;
  state.rates[key] = state.api[key]?.rate ?? NaN;
  if (state.active === `rate:${key}`) state.entry = null;
}

function currentValues() {
  return convertAll(state.anchor, state.anchorValue, state.rates);
}

// ------------------------------------------------------------------ render

function setIcon(button, id) {
  const use = button.querySelector("use");
  if (use.getAttribute("href") !== id) use.setAttribute("href", id);
}

function renderAmounts(values) {
  for (const key of AMOUNT_KEYS) {
    const node = ui.fields[key];
    const active = state.active === key;
    const text = active && state.entry !== null ? formatEntry(state.entry) : formatNumber(values[key]);

    node.classList.toggle("is-active", active);
    node.classList.toggle("is-fresh", active && state.entry === null);
    node.querySelector(".value").textContent = text;
    node.querySelector(".amount__value").dataset.len = text.length > 14 ? "xlong" : text.length > 11 ? "long" : "";

    const main = node.querySelector(".amount__main");
    main.setAttribute("aria-label", `${LABELS[key]}: ${text || "vacío"}`);
    main.toggleAttribute("aria-current", active);

    const action = node.querySelector(".amount__action");
    const clears = active && text !== "";
    setIcon(action, clears ? "#i-clear" : "#i-copy");
    action.dataset.mode = clears ? "clear" : "copy";
    action.setAttribute("aria-label", `${clears ? "Borrar" : "Copiar"} ${LABELS[key].toLowerCase()}`);
    action.disabled = text === "";
  }
}

function renderRates() {
  for (const key of RATE_KEYS) {
    const field = `rate:${key}`;
    const node = ui.fields[field];
    const active = state.active === field;
    const text = active && state.entry !== null ? formatEntry(state.entry) : formatNumber(state.rates[key], 2, 4);

    node.classList.toggle("is-active", active);
    node.classList.toggle("is-fresh", active && state.entry === null);
    node.classList.toggle("is-manual", state.manual[key]);
    node.querySelector(".value").textContent = text;

    const main = node.querySelector(".rate__main");
    main.setAttribute("aria-label", `${LABELS[field]}: ${text ? `${text} bolívares por dólar` : "sin tasa"}`);
    main.toggleAttribute("aria-current", active);

    node.querySelector(".rate__reset").hidden = !(state.manual[key] && state.api[key]);

    let meta;
    if (state.manual[key]) meta = "Manual";
    else if (state.api[key]) {
      const when = describeDate(state.api[key].date).replace(/^hoy (?=\d)/, "");
      meta = when ? `${SOURCE[key]} · ${when}` : SOURCE[key];
    } else meta = state.sync === "error" ? "Toca para escribirla" : "Cargando…";
    node.querySelector(".rate__meta").textContent = meta;
  }

  const gap = computeGap(state.rates);
  ui.gap.hidden = !Number.isFinite(gap);
  if (Number.isFinite(gap)) {
    ui.gap.textContent = `${gap >= 0 ? "+" : "−"}${formatNumber(Math.abs(gap), 1, 1)}%`;
    ui.gap.title = `P2P ${formatNumber(Math.abs(gap), 1, 1)}% ${gap >= 0 ? "sobre" : "bajo"} el BCV`;
  }
}

function renderStatus() {
  const hasRates = RATE_KEYS.some((key) => state.api[key]);
  const ago = state.fetchedAt ? timeAgo(state.fetchedAt) : "";
  let tone = "idle";
  let text = "Cargando tasas…";

  if (state.sync === "loading") {
    text = hasRates ? "Actualizando…" : "Cargando tasas…";
    tone = hasRates ? "stale" : "idle";
  } else if (state.sync === "error") {
    const reason = navigator.onLine === false ? "Sin conexión" : "No se pudo actualizar";
    text = hasRates && ago ? `${reason} · tasas de ${ago}` : `${reason} · toca una tasa para escribirla`;
    tone = hasRates ? "stale" : "bad";
  } else if (hasRates && ago) {
    text = `Actualizado ${ago}`;
    tone = Date.now() - state.fetchedAt > STALE_AFTER_MS ? "stale" : "ok";
  }

  ui.status.dataset.tone = tone;
  ui.statusText.textContent = text;
  ui.refresh.classList.toggle("is-loading", state.sync === "loading");
  ui.refresh.disabled = state.sync === "loading";
}

function render() {
  renderAmounts(currentValues());
  renderRates();
  renderStatus();
}

// ------------------------------------------------------------------ feedback

let toastTimer;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("is-visible"), 2200);
}

let announceTimer;
function announceSoon() {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    const v = currentValues();
    ui.sr.textContent = Number.isFinite(v.bs)
      ? `${formatNumber(v.bs)} bolívares equivalen a ${formatNumber(v.bcv) || "—"} dólares BCV y ${formatNumber(v.p2p) || "—"} dólares P2P`
      : "";
  }, 800);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast("No se pudo copiar");
  }
}

// ------------------------------------------------------------------ events

document.addEventListener("click", (e) => {
  const activator = e.target.closest("[data-activate]");
  if (activator) {
    activate(activator.dataset.activate);
    return;
  }

  const action = e.target.closest("[data-action-for]");
  if (action) {
    const key = action.dataset.actionFor;
    if (action.dataset.mode === "clear") {
      state.entry = "";
      commit(key);
      render();
      announceSoon();
      return;
    }
    const value = currentValues()[key];
    // Copied without thousands separators ("1234,56") so it pastes cleanly into bank apps.
    if (Number.isFinite(value)) copyText(entryFromNumber(value, 2), `Copiado: ${formatNumber(value)}`);
    return;
  }

  const reset = e.target.closest("[data-reset]");
  if (reset) {
    resetRate(reset.dataset.reset);
    render();
    toast(`Tasa ${reset.dataset.reset === "bcv" ? "BCV" : "P2P"} del día`);
  }
});

// Keyboard focus (Tab) also selects a field.
document.addEventListener("focusin", (e) => {
  const activator = e.target.closest?.("[data-activate]");
  if (activator && activator.dataset.activate !== state.active) activate(activator.dataset.activate);
});

// Keypad: act on click (works with screen readers and keyboards) but keep
// focus where it is, give instant visual feedback, and hold ⌫ to clear.
let holdTimer;
let held = false;

ui.keypad.addEventListener("pointerdown", (e) => {
  const key = e.target.closest(".key");
  if (!key) return;
  e.preventDefault();
  key.classList.add("is-pressed");
  if (key.dataset.key === "back") {
    held = false;
    holdTimer = setTimeout(() => {
      held = true;
      press("clear");
    }, 500);
  }
});

const releaseKeys = () => {
  clearTimeout(holdTimer);
  $$(".key.is-pressed").forEach((key) => key.classList.remove("is-pressed"));
};
["pointerup", "pointercancel"].forEach((type) => document.addEventListener(type, releaseKeys));
ui.keypad.addEventListener("pointerleave", releaseKeys);
ui.keypad.addEventListener("contextmenu", (e) => e.preventDefault());

ui.keypad.addEventListener("click", (e) => {
  const key = e.target.closest(".key");
  if (!key) return;
  if (key.dataset.key === "back" && held) {
    held = false;
    return;
  }
  press(key.dataset.key);
});

// Physical keyboard.
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  let key = null;
  if (/^\d$/.test(e.key)) key = e.key;
  else if (e.key === "," || e.key === "." || e.key === "Decimal") key = ",";
  else if (e.key === "Backspace") key = "back";
  else if (e.key === "Delete") key = "clear";
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const i = FIELD_ORDER.indexOf(state.active);
    const next = FIELD_ORDER[(i + (e.key === "ArrowDown" ? 1 : -1) + FIELD_ORDER.length) % FIELD_ORDER.length];
    activate(next);
    ui.fields[next].querySelector("[data-activate]").focus({ preventScroll: true });
    return;
  }
  if (!key) return;
  e.preventDefault();
  press(key);
});

// Paste a number from anywhere (desktop).
document.addEventListener("paste", (e) => {
  const value = parseAmount((e.clipboardData?.getData("text") ?? "").replace(/[^\d.,]/g, ""));
  if (!Number.isFinite(value)) return;
  e.preventDefault();
  state.entry = entryFromNumber(value, (isRateField(state.active) ? LIMITS.rate : LIMITS.amount).maxDecimals);
  commit(state.active);
  render();
  announceSoon();
});

ui.refresh.addEventListener("click", () => loadRates({ force: true }));

ui.share.addEventListener("click", async () => {
  const text = shareText(currentValues(), state.rates);
  const url = location.href.split("#")[0];
  if (navigator.share) {
    try {
      await navigator.share({ title: "CambioX", text, url });
    } catch { /* cancelled */ }
    return;
  }
  copyText(`${text}\n${url}`, "Conversión copiada");
});

// Install button (Chrome / Edge / Android). iOS uses Share → "Agregar a inicio".
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  ui.install.hidden = false;
});
ui.install.addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  ui.install.hidden = true;
});
window.addEventListener("appinstalled", () => {
  ui.install.hidden = true;
});

// Keep rates fresh: installed apps are resumed far more often than reopened.
const refreshIfOlderThan = (ms) => {
  if (Date.now() - state.fetchedAt > ms) loadRates();
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshIfOlderThan(RESUME_AFTER_MS);
});
window.addEventListener("online", () => refreshIfOlderThan(0));
setInterval(() => {
  renderStatus();
  if (document.visibilityState === "visible") refreshIfOlderThan(POLL_EVERY_MS);
}, 30 * 1000);

// ------------------------------------------------------------------ start

loadSaved();
render();
loadRates();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      // Look for a new version when a long-lived installed app is resumed (at most hourly).
      let lastCheck = Date.now();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible" || Date.now() - lastCheck < 60 * 60 * 1000) return;
        lastCheck = Date.now();
        reg.update().catch(() => {});
      });
    }).catch(() => { /* the app works without it */ });
  });
}
