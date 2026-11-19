import test from "node:test";
import assert from "node:assert/strict";

import {
  parseAmount, formatNumber, applyKey, formatEntry, entryFromNumber, convertAll,
  computeGap, parseRatesResponse, describeDate, timeAgo, shareText, LIMITS
} from "./core.js";

const rates = { bcv: 500, p2p: 625 };

test("parseAmount accepts comma or dot decimals and thousands separators", () => {
  assert.equal(parseAmount("1234,56"), 1234.56);
  assert.equal(parseAmount("1234.56"), 1234.56);
  assert.equal(parseAmount("1.234,56"), 1234.56);
  assert.equal(parseAmount("1,234.56"), 1234.56);
  assert.equal(parseAmount("1.234.567"), 1234567);
  assert.equal(parseAmount("12,"), 12);
  assert.equal(parseAmount(" 1 000,5 "), 1000.5);
  assert.ok(Number.isNaN(parseAmount("")));
  assert.ok(Number.isNaN(parseAmount("abc")));
  assert.ok(Number.isNaN(parseAmount("-5")));
});

test("formatNumber uses Venezuelan formatting and round-trips", () => {
  assert.equal(formatNumber(1072.268), "1.072,27");
  assert.equal(formatNumber(917.7751, 2, 4), "917,7751");
  assert.equal(formatNumber(1234.5, 0, 4, false), "1234,5");
  assert.equal(formatNumber(NaN), "");
  assert.equal(parseAmount(formatNumber(1234567.89)), 1234567.89);
});

test("applyKey builds an entry like a calculator", () => {
  const type = (keys, limits = LIMITS.amount) => keys.reduce((e, k) => applyKey(e, k, limits), "");
  assert.equal(type(["1", "2", ",", "5"]), "12,5");
  assert.equal(type([",", "5"]), "0,5");
  assert.equal(type(["0", "0", "7"]), "7");
  assert.equal(type(["1", ",", ",", "2"]), "1,2");
  assert.equal(type(["1", ",", "2", "3", "4"]), "1,23");
  assert.equal(type(["1", ",", "2", "3", "4", "5"], LIMITS.rate), "1,2345");
  assert.equal(type(["9", "8", "back"]), "9");
  assert.equal(type(["9", "8", "clear"]), "");
  assert.equal(type(Array(20).fill("9")).length, LIMITS.amount.maxInt);
});

test("formatEntry groups the integer part and keeps typed decimals", () => {
  assert.equal(formatEntry("1234567,5"), "1.234.567,5");
  assert.equal(formatEntry("0,"), "0,");
  assert.equal(formatEntry("1000"), "1.000");
  assert.equal(formatEntry(""), "");
  assert.equal(entryFromNumber(1234.567, 2), "1234,57");
});

test("convertAll from bolívares fills both dollar amounts", () => {
  assert.deepEqual(convertAll("bs", 1000, rates), { bs: 1000, bcv: 2, p2p: 1.6 });
});

test("convertAll keeps the typed dollar amount exactly", () => {
  assert.deepEqual(convertAll("p2p", 100, rates), { bs: 62500, bcv: 125, p2p: 100 });
  assert.deepEqual(convertAll("bcv", 10, rates), { bs: 5000, bcv: 10, p2p: 8 });
});

test("changing a rate only changes the derived amounts, never the typed one", () => {
  const after = convertAll("p2p", 100, { ...rates, p2p: 700 });
  assert.equal(after.p2p, 100);
  assert.equal(after.bs, 70000);
  assert.equal(after.bcv, 140);
});

test("convertAll leaves a field empty when its rate is missing", () => {
  const r = convertAll("bs", 1000, { bcv: 500, p2p: NaN });
  assert.equal(r.bcv, 2);
  assert.ok(Number.isNaN(r.p2p));
  assert.ok(Object.values(convertAll("bs", NaN, rates)).every(Number.isNaN));
});

test("computeGap returns the P2P premium over BCV", () => {
  assert.equal(computeGap(rates), 25);
  assert.equal(computeGap({ bcv: 500, p2p: 450 }), -10);
  assert.ok(Number.isNaN(computeGap({ bcv: 0, p2p: 450 })));
});

test("parseRatesResponse reads both rates from one /v1/dolares response", () => {
  const response = [
    { moneda: "USD", fuente: "oficial", compra: null, venta: null, promedio: 917.7751, fechaActualizacion: "2026-11-19T00:00:00-04:00" },
    { moneda: "USD", fuente: "paralelo", compra: null, venta: null, promedio: 1072.268492, fechaActualizacion: "2026-11-19T14:01:01.179Z" }
  ];
  assert.deepEqual(parseRatesResponse(response), {
    bcv: { rate: 917.7751, date: "2026-11-19T00:00:00-04:00" },
    p2p: { rate: 1072.268492, date: "2026-11-19T14:01:01.179Z" }
  });
  assert.deepEqual(parseRatesResponse([{ fuente: "oficial", promedio: null }]), { bcv: null, p2p: null });
  assert.deepEqual(parseRatesResponse({ error: "x" }), { bcv: null, p2p: null });
});

test("describeDate and timeAgo", () => {
  const now = new Date("2026-11-19T15:00:00-04:00");
  assert.equal(describeDate("2026-11-19T00:00:00-04:00", now), "hoy");
  assert.match(describeDate("2026-11-19T14:01:01.179Z", now), /^hoy 10:01/);
  assert.match(describeDate("2026-11-18T12:00:00-04:00", now), /^18 nov/);
  assert.equal(describeDate("not a date", now), "");

  const t = now.getTime();
  assert.equal(timeAgo(t - 20 * 1000, t), "hace un momento");
  assert.equal(timeAgo(t - 5 * 60 * 1000, t), "hace 5 minutos");
  assert.equal(timeAgo(t - 3 * 3600 * 1000, t), "hace 3 horas");
  assert.equal(timeAgo(t - 26 * 3600 * 1000, t), "ayer");
});

test("shareText summarises the conversion", () => {
  assert.equal(
    shareText(convertAll("p2p", 100, rates), rates),
    "Bs 62.500,00\n$125,00 a tasa BCV (500,00)\n$100,00 a tasa P2P (625,00)"
  );
  assert.equal(shareText(convertAll("bs", NaN, rates), rates), "Tasa BCV: Bs 500,00\nTasa P2P: Bs 625,00");
});
