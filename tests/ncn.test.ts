import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNCN } from '../src/lib/ncnParser.ts';

test('parseNCN detects easting/northing order for common Turkish coordinates', () => {
  const result = parseNCN([
    'P1 500000.000 4100000.000 100.250',
    'P2 500010.000 4100015.000 101.500',
  ].join('\n'));

  assert.equal(result.format, 'YXZ');
  assert.equal(result.points.length, 2);
  assert.deepEqual(result.points[0], {
    name: 'P1',
    lat: 4100000,
    lon: 500000,
    alt: 100.25,
  });
});

test('parseNCN skips invalid rows and reports warnings', () => {
  const result = parseNCN('P1 500000 4100000 100\nBAD 1 text 3\n');

  assert.equal(result.points.length, 1);
  assert.ok(result.warnings.length >= 1);
});
