const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAmount, formatNumber, convertAll, computeGap, extractRate, describeDate } = require('./app.js');

const rates = { bcv: 500, p2p: 625 };

test('parseAmount accepts comma or dot decimals and thousands separators', () => {
  assert.equal(parseAmount('1234,56'), 1234.56);
  assert.equal(parseAmount('1234.56'), 1234.56);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('1.234.567'), 1234567);
  assert.equal(parseAmount('1,5'), 1.5);
  assert.equal(parseAmount('12,'), 12);
  assert.equal(parseAmount(',5'), 0.5);
  assert.equal(parseAmount(' 1 000,5 '), 1000.5);
});

test('parseAmount rejects empty or invalid input', () => {
  assert.ok(Number.isNaN(parseAmount('')));
  assert.ok(Number.isNaN(parseAmount(',')));
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.ok(Number.isNaN(parseAmount('-5')));
  assert.ok(Number.isNaN(parseAmount(null)));
});

test('formatNumber uses Venezuelan formatting and round-trips through parseAmount', () => {
  assert.equal(formatNumber(1072.268), '1.072,27');
  assert.equal(formatNumber(917.7751, 2, 4), '917,7751');
  assert.equal(formatNumber(1234.5, 0, 4, false), '1234,5');
  assert.equal(formatNumber(NaN), '');
  assert.equal(parseAmount(formatNumber(1234567.89)), 1234567.89);
});

test('convertAll from bolívares fills both USD amounts', () => {
  assert.deepEqual(convertAll('bs', 1000, rates), { bs: 1000, bcv: 2, p2p: 1.6 });
});

test('convertAll from a USD amount keeps that amount exactly', () => {
  assert.deepEqual(convertAll('p2p', 100, rates), { bs: 62500, bcv: 125, p2p: 100 });
  assert.deepEqual(convertAll('bcv', 10, rates), { bs: 5000, bcv: 10, p2p: 8 });
});

test('changing a rate only changes the derived amounts, never the typed one', () => {
  const before = convertAll('p2p', 100, rates);
  const after = convertAll('p2p', 100, { ...rates, p2p: 700 });
  assert.equal(after.p2p, before.p2p);
  assert.equal(after.bs, 70000);
  assert.equal(after.bcv, 140);
});

test('convertAll leaves a field empty when its rate is missing', () => {
  const r = convertAll('bs', 1000, { bcv: 500, p2p: NaN });
  assert.equal(r.bcv, 2);
  assert.ok(Number.isNaN(r.p2p));

  const noRate = convertAll('bcv', 10, { bcv: NaN, p2p: 625 });
  assert.equal(noRate.bcv, 10);
  assert.ok(Number.isNaN(noRate.bs));
  assert.ok(Number.isNaN(noRate.p2p));
});

test('convertAll with an empty value clears everything', () => {
  const r = convertAll('bs', NaN, rates);
  assert.ok(Object.values(r).every(Number.isNaN));
});

test('computeGap returns the P2P premium over BCV', () => {
  assert.equal(computeGap(rates), 25);
  assert.equal(computeGap({ bcv: 500, p2p: 450 }), -10);
  assert.ok(Number.isNaN(computeGap({ bcv: 0, p2p: 450 })));
});

test('extractRate reads the dolarapi.com response', () => {
  assert.equal(extractRate({ compra: null, venta: null, promedio: 917.7751 }), 917.7751);
  assert.equal(extractRate({ promedio: null, venta: '36.5' }), 36.5);
  assert.ok(Number.isNaN(extractRate({ promedio: null })));
  assert.ok(Number.isNaN(extractRate(null)));
});

test('describeDate labels today vs. earlier days in Venezuelan time', () => {
  const now = new Date('2026-11-19T15:00:00-04:00');
  assert.equal(describeDate('2026-11-19T00:00:00-04:00', now), 'hoy');
  assert.match(describeDate('2026-11-19T14:01:01.179Z', now), /^hoy 10:01/);
  assert.match(describeDate('2026-11-18T12:00:00-04:00', now), /^18 nov/);
  assert.equal(describeDate('not a date', now), '');
});
