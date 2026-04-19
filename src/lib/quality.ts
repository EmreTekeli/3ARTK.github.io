import type { NMEAData } from './nmea';

export type AccuracyMode = 'RTK_STRICT' | 'RTK_NORMAL' | 'TEST';

export type RtkQualityResult = {
  ok: boolean;
  reason: string;
  maxSurfaceRms: number;
};

export const ACCURACY_MODE_LABELS: Record<AccuracyMode, string> = {
  RTK_STRICT: 'RTK Hassas',
  RTK_NORMAL: 'RTK Normal',
  TEST: 'Test / Telefon',
};

export function getMaxSurfaceRms(mode: AccuracyMode): number {
  if (mode === 'RTK_STRICT') return 0.05;
  if (mode === 'RTK_NORMAL') return 0.10;
  return 0.35;
}

export function evaluateRtkQuality(
  point: Pick<NMEAData, 'fix' | 'hdop' | 'satellites'> | null,
  mode: AccuracyMode,
  residualRMS = 0,
  surfaceActive = false,
): RtkQualityResult {
  const maxSurfaceRms = getMaxSurfaceRms(mode);

  if (!point) {
    return { ok: false, reason: 'GNSS verisi yok', maxSurfaceRms };
  }

  if (mode === 'RTK_STRICT') {
    if (point.fix !== 4) return { ok: false, reason: 'RTK Fixed gerekli', maxSurfaceRms };
    if (point.hdop > 1.2) return { ok: false, reason: `HDOP yuksek (${point.hdop.toFixed(1)})`, maxSurfaceRms };
    if (point.satellites > 0 && point.satellites < 8) return { ok: false, reason: `Uydu az (${point.satellites})`, maxSurfaceRms };
  } else if (mode === 'RTK_NORMAL') {
    if (point.fix !== 4 && point.fix !== 5) return { ok: false, reason: 'RTK Fixed/Float gerekli', maxSurfaceRms };
    if (point.hdop > 2.0) return { ok: false, reason: `HDOP yuksek (${point.hdop.toFixed(1)})`, maxSurfaceRms };
    if (point.satellites > 0 && point.satellites < 6) return { ok: false, reason: `Uydu az (${point.satellites})`, maxSurfaceRms };
  } else {
    if (point.fix === 0) return { ok: false, reason: 'Fix yok', maxSurfaceRms };
    if (point.hdop > 10.0) return { ok: false, reason: `Konum dogrulugu zayif (${point.hdop.toFixed(1)})`, maxSurfaceRms };
  }

  if (surfaceActive && residualRMS > maxSurfaceRms) {
    return {
      ok: false,
      reason: `Yuzey RMS yuksek (${Math.round(residualRMS * 1000)}mm)`,
      maxSurfaceRms,
    };
  }

  return { ok: true, reason: 'Kalite uygun', maxSurfaceRms };
}
