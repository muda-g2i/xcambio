/* CambioX: Bolívares ⇄ USD (BCV y P2P). Static site, no build step. */

// ---------------------------------------------------------------------------
// Pure helpers (no DOM). Exported at the bottom so app.test.js can cover them.
// ---------------------------------------------------------------------------

const LOCALE = "es-VE";
const TIME_ZONE = "America/Caracas";

/** Amount fields: Bs, USD at the BCV rate, USD at the P2P rate. */
const AMOUNT_KEYS = ["bs", "bcv", "p2p"];
/** Rate keys match the USD amount field they convert. */
const RATE_KEYS = ["bcv", "p2p"];

const isValidRate = (r) => Number.isFinite(r) && r > 0;

/**
 * Parse what a person typed. Accepts "1234,56", "1234.56", "1.234,56" and
 * "1,234.56". With only one kind of separator, a single one is the decimal
 * mark and repeated ones are thousands separators.
 * Returns NaN for empty or invalid input.
 */
function parseAmount(raw) {
  let s = String(raw ?? "").replace(/[\s ]/g, "");
  if (!s) return NaN;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? "," : ".";
    const group = decimal === "," ? "." : ",";
    s = s.split(group).join("").replace(decimal, ".");
  } else if (lastComma !== -1) {
    s = s.indexOf(",") === lastComma ? s.replace(",", ".") : s.split(",").join("");
  } else if (lastDot !== -1 && s.indexOf(".") !== lastDot) {
    s = s.split(".").join("");
  }

  if (!/^\d*\.?\d*$/.test(s) || s === ".") return NaN;
  return Number(s);
}

const numberFormats = new Map();

/** Locale-format a number ("1.234,56"). Returns "" for non-finite values. */
function formatNumber(n, minFrac = 2, maxFrac = 2, grouping = true) {
  if (!Number.isFinite(n)) return "";
  const key = `${minFrac}|${maxFrac}|${grouping}`;
  let nf = numberFormats.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: minFrac,
      maximumFractionDigits: maxFrac,
      useGrouping: grouping ? "always" : false
    });
    numberFormats.set(key, nf);
  }
  return nf.format(n);
}

/**
 * Given the field the person typed in (the anchor) and its value, compute all
 * three amounts. The anchor value is returned untouched; a field whose rate is
 * missing comes back as NaN instead of a wrong number.
 */
function convertAll(anchor, value, rates) {
  const out = { bs: NaN, bcv: NaN, p2p: NaN };
  if (!Number.isFinite(value) || value < 0) return out;

  out[anchor] = value;

  let bs;
  if (anchor === "bs") bs = value;
  else if (isValidRate(rates[anchor])) bs = value * rates[anchor];
  else return out;

  out.bs = bs;
  for (const key of RATE_KEYS) {
    if (key !== anchor) out[key] = isValidRate(rates[key]) ? bs / rates[key] : NaN;
  }
  return out;
}

/** Percentage the P2P rate sits above (positive) or below the BCV rate. */
function computeGap(rates) {
  if (!isValidRate(rates.bcv) || !isValidRate(rates.p2p)) return NaN;
  return ((rates.p2p - rates.bcv) / rates.bcv) * 100;
}

/** Pull the rate out of a dolarapi.com response. */
function extractRate(data) {
  if (!data || typeof data !== "object") return NaN;
  for (const field of ["promedio", "venta", "compra", "price", "tasa", "value"]) {
    const n = Number(data[field]);
    if (data[field] != null && isValidRate(n)) return n;
  }
  return NaN;
}

/** "hoy 10:01 a. m.", "hoy" or "18 nov." for a rate's timestamp, in Venezuelan time. */
function describeDate(dateStr, now = new Date()) {
  const d = new Date(dateStr);
  if (!dateStr || Number.isNaN(d.getTime())) return "";

  const dayKey = (x) => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(x);
  const time = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(d);
  const midnight = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d) === "00:00";

  if (dayKey(d) === dayKey(now)) return midnight ? "hoy" : `hoy ${time}`;
  return new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, day: "numeric", month: "short" }).format(d);
}

// ---------------------------------------------------------------------------
// App (browser only)
// ---------------------------------------------------------------------------

(() => {
  "use strict";

  if (typeof document === "undefined") return;

  const API = {
    bcv: "https://ve.dolarapi.com/v1/dolares/oficial",
    p2p: "https://ve.dolarapi.com/v1/dolares/paralelo"
  };
  // Same keys as earlier versions so saved rates survive the update.
  const CACHE_KEYS = { bcv: "cambio-ve:bcv-rate", p2p: "cambio-ve:parallel-rate" };
  const FETCH_TIMEOUT_MS = 8000;
  const STALE_AFTER_MS = 12 * 60 * 60 * 1000;
  const AUTO_REFRESH_AFTER_MS = 10 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const amountInputs = { bs: $("bs-input"), bcv: $("bcv-usd-input"), p2p: $("parallel-usd-input") };
  const rateInputs = { bcv: $("bcv-rate-input"), p2p: $("parallel-rate-input") };
  const rateMeta = { bcv: $("bcv-meta"), p2p: $("parallel-meta") };
  const rateRows = { bcv: $("bcv-row"), p2p: $("parallel-row") };
  const gapText = $("gap-text");
  const refreshBtn = $("refresh-rates-btn");
  const refreshStatus = $("refresh-status");

  // Single source of truth; inputs are only a view of this state.
  const state = {
    anchor: "bs", // the amount field the person typed in last; it is never recalculated
    anchorValue: NaN,
    rates: { bcv: NaN, p2p: NaN },
    rateOrigin: { bcv: null, p2p: null }, // "api" | "cache" | "manual"
    lastGood: { bcv: null, p2p: null }, // last API/cached rate, to restore an emptied field
    lastFetchAt: 0,
    loading: null
  };

  // ---- storage --------------------------------------------------------------

  function loadCache(key) {
    try {
      const data = JSON.parse(localStorage.getItem(CACHE_KEYS[key]));
      return data && isValidRate(Number(data.rate)) ? { ...data, rate: Number(data.rate) } : null;
    } catch {
      return null;
    }
  }

  function saveCache(key, rate, sourceDate) {
    try {
      localStorage.setItem(CACHE_KEYS[key], JSON.stringify({ rate, sourceDate, fetchedAt: Date.now() }));
    } catch {
      // storage full or blocked: the app still works without it
    }
  }

  // ---- rendering ------------------------------------------------------------

  const isEditing = (el) => document.activeElement === el;

  function fitText(el) {
    el.classList.toggle("is-long", el.value.length > 10);
    el.classList.toggle("is-very-long", el.value.length > 13);
  }

  function renderAmounts() {
    const values = convertAll(state.anchor, state.anchorValue, state.rates);
    for (const key of AMOUNT_KEYS) {
      const el = amountInputs[key];
      el.closest(".calc__field").classList.toggle("is-anchor", key === state.anchor && Number.isFinite(state.anchorValue));
      if (isEditing(el)) continue; // never rewrite what the person is typing
      el.value = key === state.anchor ? formatNumber(values[key], 2, 4) : formatNumber(values[key]);
      fitText(el);
    }
  }

  function renderGap() {
    const gap = computeGap(state.rates);
    gapText.className = "";
    if (!Number.isFinite(gap)) {
      gapText.textContent = "Ingresa ambas tasas para ver la brecha";
      return;
    }
    const above = gap >= 0;
    gapText.className = `gap-pill ${above ? "gap-pill--warn" : "gap-pill--good"}`;
    gapText.textContent = `P2P ${above ? "+" : "−"}${formatNumber(Math.abs(gap), 1, 1)}% ${above ? "sobre" : "bajo"} el BCV`;
  }

  function setRate(key, rate, origin, metaText, stale = false) {
    state.rates[key] = isValidRate(rate) ? rate : NaN;
    state.rateOrigin[key] = origin;
    if (origin !== "manual" && isValidRate(rate)) state.lastGood[key] = { rate, metaText, stale };
    if (!isEditing(rateInputs[key])) rateInputs[key].value = formatNumber(state.rates[key], 2, 4);
    setMeta(key, metaText, stale ? "stale" : origin === "manual" ? "manual" : null);
    renderAmounts();
    renderGap();
  }

  function setMeta(key, text, tone) {
    rateMeta[key].textContent = text;
    rateRows[key].classList.toggle("stale", tone === "stale");
    rateRows[key].classList.toggle("manual", tone === "manual");
  }

  const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  function describeCached(cached) {
    return describeDate(cached.sourceDate) || describeDate(cached.fetchedAt) || "guardada";
  }

  // ---- network --------------------------------------------------------------

  async function fetchRate(key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(API[key], { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const rate = extractRate(data);
      if (!isValidRate(rate)) throw new Error("no rate in response");
      return { rate, sourceDate: data.fechaActualizacion || data.date || null };
    } finally {
      clearTimeout(timer);
    }
  }

  let statusTimer;

  /**
   * Fetch both rates. Each one is applied as soon as it arrives.
   * force=false (start-up / returning to the app) keeps a rate the person typed by hand;
   * force=true (the ↻ button) replaces it.
   */
  function loadRates({ force }) {
    if (state.loading) return state.loading;

    refreshBtn.disabled = true;
    refreshBtn.classList.add("is-loading");
    clearTimeout(statusTimer);
    refreshStatus.textContent = "Actualizando…";

    const jobs = RATE_KEYS.map(async (key) => {
      try {
        const { rate, sourceDate } = await fetchRate(key);
        saveCache(key, rate, sourceDate);
        const metaText = capitalize(describeDate(sourceDate) || "hoy");
        if (force || state.rateOrigin[key] !== "manual") setRate(key, rate, "api", metaText);
        else state.lastGood[key] = { rate, metaText, stale: false };
        return true;
      } catch {
        if (state.rateOrigin[key] === "manual") return false;
        const cached = loadCache(key);
        if (cached) setRate(key, cached.rate, "cache", `Sin actualizar · ${describeCached(cached)}`, true);
        else if (!isValidRate(state.rates[key])) setMeta(key, "No se pudo cargar · escríbela", "stale");
        return false;
      }
    });

    state.loading = Promise.all(jobs).then((results) => {
      const ok = results.every(Boolean);
      if (ok) state.lastFetchAt = Date.now();
      refreshStatus.textContent = ok ? "Actualizado" : "Sin actualizar";
      clearTimeout(statusTimer);
      if (ok) statusTimer = setTimeout(() => (refreshStatus.textContent = ""), 4000);
      refreshBtn.disabled = false;
      refreshBtn.classList.remove("is-loading");
      state.loading = null;
    });
    return state.loading;
  }

  function initRates() {
    // Show the last saved rates right away (even old ones, flagged), then refresh.
    for (const key of RATE_KEYS) {
      const cached = loadCache(key);
      if (cached) {
        const stale = Date.now() - (cached.fetchedAt || 0) > STALE_AFTER_MS;
        setRate(key, cached.rate, "cache", capitalize(describeCached(cached)), stale);
      } else {
        setMeta(key, "Cargando…", null);
      }
    }
    renderGap();
    loadRates({ force: false });
  }

  // ---- input handling -------------------------------------------------------

  function sanitize(el) {
    const clean = el.value.replace(/[^\d.,]/g, "");
    if (clean !== el.value) el.value = clean;
  }

  function enableEditing(el, value, maxFrac) {
    // Show an ungrouped number while editing ("1234,56") and select it, so typing replaces it.
    const selectAll = () => el.setSelectionRange(0, el.value.length);
    let selectOnPointerUp = false;

    el.addEventListener("focus", () => {
      const n = value();
      if (Number.isFinite(n)) el.value = formatNumber(n, 0, maxFrac, false);
      selectAll();
      selectOnPointerUp = true;
    });
    // On a tap or click the browser places the caret on mouseup, undoing the selection.
    el.addEventListener("mouseup", (e) => {
      if (!selectOnPointerUp) return;
      selectOnPointerUp = false;
      e.preventDefault();
      selectAll();
    });
    el.addEventListener("keydown", (e) => {
      selectOnPointerUp = false;
      if (e.key === "Enter") el.blur();
    });
    el.addEventListener("blur", () => {
      selectOnPointerUp = false;
    });
  }

  for (const key of AMOUNT_KEYS) {
    const el = amountInputs[key];
    el.addEventListener("input", () => {
      sanitize(el);
      fitText(el);
      state.anchor = key;
      state.anchorValue = parseAmount(el.value);
      renderAmounts();
    });
    el.addEventListener("blur", renderAmounts);
    enableEditing(el, () => (key === state.anchor ? state.anchorValue : parseAmount(el.value)), 4);
  }

  for (const key of RATE_KEYS) {
    const el = rateInputs[key];
    el.addEventListener("input", () => {
      sanitize(el);
      // Only this rate changes. The amount the person typed stays fixed;
      // the amounts derived from it are recalculated.
      setRate(key, parseAmount(el.value), "manual", "Manual · ↻ restaura");
    });
    el.addEventListener("blur", () => {
      const good = state.lastGood[key];
      if (!isValidRate(state.rates[key]) && good) {
        setRate(key, good.rate, "cache", good.metaText, good.stale);
      } else {
        el.value = formatNumber(state.rates[key], 2, 4);
      }
    });
    enableEditing(el, () => state.rates[key], 4);
  }

  refreshBtn.addEventListener("click", () => loadRates({ force: true }));

  // Installed apps are often resumed instead of reopened: refresh rates when
  // the app comes back to the foreground or the connection returns.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - state.lastFetchAt > AUTO_REFRESH_AFTER_MS) {
      loadRates({ force: false });
    }
  });
  window.addEventListener("online", () => {
    if (Date.now() - state.lastFetchAt > AUTO_REFRESH_AFTER_MS) loadRates({ force: false });
  });

  initRates();

  // Desktop only: focusing on load would pop the keyboard up on phones.
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) amountInputs.bs.focus();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").then((reg) => {
        // Check for a new version when a long-lived installed app is resumed (at most hourly).
        let lastCheck = Date.now();
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState !== "visible" || Date.now() - lastCheck < 60 * 60 * 1000) return;
          lastCheck = Date.now();
          reg.update().catch(() => {});
        });
      }).catch(() => {
        // the app works without the service worker
      });
    });
  }
})();

if (typeof module !== "undefined") {
  module.exports = { parseAmount, formatNumber, convertAll, computeGap, extractRate, describeDate };
}
