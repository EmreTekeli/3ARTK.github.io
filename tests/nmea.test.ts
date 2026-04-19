import test from 'node:test';
import assert from 'node:assert/strict';
import { getFixLabel, parseNMEA } from '../src/lib/nmea.ts';

test('parseNMEA parses GGA positions and ellipsoidal height', () => {
  const parsed = parseNMEA('$GPGGA,123519,4107.000,N,02900.000,E,4,12,0.8,100.0,M,35.0,M,,');

  assert.ok(parsed);
  assert.equal(parsed.fix, 4);
  assert.equal(parsed.satellites, 12);
  assert.equal(parsed.hdop, 0.8);
  assert.equal(parsed.mslAlt, 100);
  assert.equal(parsed.geoidSep, 35);
  assert.equal(parsed.alt, 135);
  assert.ok(Math.abs(parsed.lat - 41.1166666667) < 1e-9);
  assert.equal(parsed.lon, 29);
});

test('parseNMEA rejects invalid fixes', () => {
  const parsed = parseNMEA('$GPGGA,123519,4107.000,N,02900.000,E,0,12,0.8,100.0,M,35.0,M,,');
  assert.equal(parsed, null);
});

test('getFixLabel maps RTK quality labels', () => {
  assert.equal(getFixLabel(4).label, 'RTK Fixed');
  assert.equal(getFixLabel(5).label, 'RTK Float');
  assert.equal(getFixLabel(0).label, 'Fix Yok');
});
