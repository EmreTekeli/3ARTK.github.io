import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPoleHeightToPoint,
  normalizeCorrectionProfile,
  rtcmBase64ToBytes,
  rtcmBytesToBase64,
  TUSAGA_CORRECTION_PROFILE,
  validateCorrectionProfile,
} from '../src/lib/rtk';

test('validates and normalizes TUSAGA correction profiles', () => {
  const profile = normalizeCorrectionProfile({
    ...TUSAGA_CORRECTION_PROFILE,
    mountPoint: '/VRSRTCM3.1',
    sendGgaIntervalMs: 100,
  });

  assert.equal(profile.host, '212.156.70.42');
  assert.equal(profile.port, 2101);
  assert.equal(profile.mountPoint, 'VRSRTCM3.1');
  assert.equal(profile.sendGgaIntervalMs, 1000);
  assert.equal(validateCorrectionProfile(profile), null);
});

test('rejects invalid NTRIP profile fields', () => {
  assert.equal(validateCorrectionProfile({ host: '', mountPoint: 'VRSRTCM3.1' }), 'NTRIP host zorunlu.');
  assert.equal(validateCorrectionProfile({ host: 'bad host', mountPoint: 'VRSRTCM3.1' }), 'NTRIP host gecersiz.');
  assert.equal(validateCorrectionProfile({ host: 'caster.example.com', port: 70000, mountPoint: 'VRSRTCM3.1' }), 'NTRIP port gecersiz.');
  assert.equal(validateCorrectionProfile({ host: 'caster.example.com', port: 2101, mountPoint: '' }), 'NTRIP mountpoint zorunlu.');
});

test('roundtrips RTCM bytes through base64', () => {
  const input = new Uint8Array([0xd3, 0x00, 0x13, 0x3e, 0xff, 0x00]);
  const encoded = rtcmBytesToBase64(input);
  const output = rtcmBase64ToBytes(encoded);
  assert.deepEqual(Array.from(output), Array.from(input));
});

test('applies pole height correction without mutating antenna height', () => {
  const corrected = applyPoleHeightToPoint({
    lat: 39,
    lon: 35,
    alt: 102,
    mslAlt: 100,
    geoidSep: 2,
    fix: 4,
    satellites: 12,
    hdop: 0.7,
  }, 2);

  assert.equal(corrected.alt, 100);
  assert.equal(corrected.mslAlt, 98);
  assert.equal(corrected.antennaAlt, 102);
  assert.equal(corrected.poleHeight, 2);
});
