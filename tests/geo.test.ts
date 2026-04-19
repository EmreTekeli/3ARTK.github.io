import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDistance, calculateDistanceFromMetricPoints } from '../src/lib/geo.ts';

test('calculateDistance handles projected coordinates in meters', () => {
  const result = calculateDistance(4100000, 500010, 100, 4100000, 500000, 96);

  assert.equal(result.horizontalDistance, 10);
  assert.equal(result.elevationDifference, 4);
  assert.equal(result.realDistance, Math.sqrt(116));
  assert.equal(result.deltaEast, 10);
  assert.equal(result.deltaNorth, 0);
  assert.equal(result.isProjected, true);
});

test('calculateDistanceFromMetricPoints returns signed deltas to target', () => {
  const result = calculateDistanceFromMetricPoints([10, 20, 5], [7, 15, 1]);

  assert.equal(result.deltaEast, 3);
  assert.equal(result.deltaNorth, 5);
  assert.equal(result.elevationDifference, 4);
  assert.equal(result.horizontalDistance, Math.sqrt(34));
});
