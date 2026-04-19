import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slopeAzimuthFromNormal,
  pointCloudExtent,
  regionalPlaneZ,
  fitSurfaceModelWithReport,
  type Point3D,
  type GeoPoint3D,
} from '../src/lib/geo.ts';

test('slopeAzimuthFromNormal returns 0 for a horizontal plane', () => {
  const az = slopeAzimuthFromNormal([0, 0, 1]);
  assert.equal(az, 0);
});

test('slopeAzimuthFromNormal points downhill toward +X (east) when normal tilts from east to up', () => {
  // Yüzeyin doğuya doğru düştüğü durum: normal +x bileseni pozitif.
  // Yokuşun aşağı yönü: -x = batı → 270°
  const az = slopeAzimuthFromNormal([0.5, 0, 0.87]);
  assert.equal(Math.round(az), 270);
});

test('slopeAzimuthFromNormal returns 0-360 range always', () => {
  for (let i = 0; i < 16; i++) {
    const theta = (i * Math.PI * 2) / 16;
    const n: Point3D = [Math.cos(theta), Math.sin(theta), 0.5];
    const az = slopeAzimuthFromNormal(n);
    assert.ok(az >= 0 && az < 360, `azimuth out of range: ${az}`);
  }
});

test('pointCloudExtent returns 0 for a single point or empty', () => {
  assert.equal(pointCloudExtent([]), 0);
  assert.equal(pointCloudExtent([[1, 2, 3]]), 0);
});

test('pointCloudExtent returns bbox diagonal for an axis-aligned box', () => {
  const pts: Point3D[] = [
    [0, 0, 0],
    [3, 4, 0],
    [1, 2, 5],
  ];
  // bbox: (0..3) × (0..4) → diagonal = 5
  assert.equal(pointCloudExtent(pts), 5);
});

test('pointCloudExtent near-zero for collinear points on same y', () => {
  const pts: Point3D[] = [
    [0, 1, 0],
    [2, 1, 0],
    [4, 1, 0],
  ];
  // x spread = 4, y spread = 0 → extent = 4
  assert.equal(pointCloudExtent(pts), 4);
});

test('regionalPlaneZ returns null when too few neighbors', () => {
  const result = regionalPlaneZ([0, 0, 0], [[0, 0, 0], [1, 1, 1]], 3);
  assert.equal(result, null);
});

test('regionalPlaneZ interpolates Z on a tilted plane', () => {
  // Düzlem: z = 0.1·x + 0·y  → (5, 5, ?) ≈ 0.5
  const neighbors: Point3D[] = [
    [0, 0, 0],
    [10, 0, 1],
    [0, 10, 0],
    [10, 10, 1],
    [5, 0, 0.5],
    [0, 5, 0],
  ];
  const result = regionalPlaneZ([5, 5, 0], neighbors, 3, 6);
  assert.ok(result, 'expected non-null');
  assert.ok(Math.abs(result!.z - 0.5) < 0.05, `z=${result!.z} expected ~0.5`);
});

test('fitSurfaceModelWithReport returns candidates with debug scores', () => {
  const ref: GeoPoint3D = { lat: 39.0, lon: 32.0, alt: 100 };
  const cur: GeoPoint3D = { lat: 39.0001, lon: 32.0001, alt: 100.5 };
  const project: GeoPoint3D[] = [
    { lat: 39.00005, lon: 32.00005, alt: 100.2 },
    { lat: 39.00008, lon: 32.00012, alt: 100.3 },
    { lat: 39.00010, lon: 32.00002, alt: 100.4 },
    { lat: 39.00015, lon: 32.00020, alt: 100.6 },
  ];
  const gnss: GeoPoint3D[] = [];
  const report = fitSurfaceModelWithReport(ref, cur, project, gnss);
  assert.ok(report.candidates.length >= 3, 'expected 3 candidate debug entries');
  const projectCand = report.candidates.find(c => c.source === 'project');
  assert.ok(projectCand, 'project candidate missing');
  assert.ok(projectCand!.pointsUsed >= 3);
  assert.ok(projectCand!.extentMeters > 0);
});

test('fitSurfaceModelWithReport rejects collinear cloud via extent guard', () => {
  const ref: GeoPoint3D = { lat: 39.0, lon: 32.0, alt: 100 };
  const cur: GeoPoint3D = { lat: 39.0000001, lon: 32.0000001, alt: 100 };
  // Tum noktalar referansa cok yakin, yayilim ~0
  const project: GeoPoint3D[] = [
    { lat: 39.0000002, lon: 32.0000002, alt: 100.01 },
    { lat: 39.0000003, lon: 32.0000003, alt: 100.02 },
    { lat: 39.0000004, lon: 32.0000004, alt: 100.03 },
  ];
  const report = fitSurfaceModelWithReport(ref, cur, project, []);
  const projectCand = report.candidates.find(c => c.source === 'project');
  assert.ok(projectCand, 'project candidate missing');
  assert.equal(projectCand!.accepted, false);
  assert.ok(
    projectCand!.rejectionReason?.includes('Yayilim') || projectCand!.rejectionReason?.includes('yayilim') || projectCand!.extentMeters < 0.5,
    `expected extent-related rejection, got: ${projectCand!.rejectionReason}`
  );
});
