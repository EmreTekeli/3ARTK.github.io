import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRtkQuality, getMaxSurfaceRms } from '../src/lib/quality.ts';

test('strict mode requires RTK Fixed and tight surface RMS', () => {
  assert.equal(getMaxSurfaceRms('RTK_STRICT'), 0.05);
  assert.equal(evaluateRtkQuality({ fix: 4, hdop: 0.8, satellites: 10 }, 'RTK_STRICT', 0.03, true).ok, true);
  assert.equal(evaluateRtkQuality({ fix: 5, hdop: 0.8, satellites: 10 }, 'RTK_STRICT').ok, false);
  assert.equal(evaluateRtkQuality({ fix: 4, hdop: 0.8, satellites: 10 }, 'RTK_STRICT', 0.08, true).ok, false);
});

test('normal mode allows RTK Float but rejects weak GNSS quality', () => {
  assert.equal(evaluateRtkQuality({ fix: 5, hdop: 1.5, satellites: 7 }, 'RTK_NORMAL', 0.09, true).ok, true);
  assert.equal(evaluateRtkQuality({ fix: 1, hdop: 1.5, satellites: 7 }, 'RTK_NORMAL').ok, false);
  assert.equal(evaluateRtkQuality({ fix: 4, hdop: 2.5, satellites: 7 }, 'RTK_NORMAL').ok, false);
});

test('test mode accepts non RTK fixes for phone GPS workflows', () => {
  assert.equal(evaluateRtkQuality({ fix: 1, hdop: 5, satellites: 0 }, 'TEST').ok, true);
  assert.equal(evaluateRtkQuality({ fix: 1, hdop: 11, satellites: 0 }, 'TEST').ok, false);
});
