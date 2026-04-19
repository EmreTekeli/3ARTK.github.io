import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import {
  fitSurfaceModelWithReport,
  type GeoPoint3D,
  type SurfaceFitReport,
  type SurfaceModel,
} from '../lib/geo';

interface Options {
  importedPoints: GeoPoint3D[];
  gnssSamplesRef: MutableRefObject<GeoPoint3D[]>;
}

/**
 * Yüzey modeli hesaplayıcısı — hız bazlı cache TTL ile.
 * importedPoints veya reference değiştiğinde cache otomatik temizlenir.
 *
 * compute(anchor, current) çağrıldığında:
 *   - Cache geçerliyse (TTL içinde) önbelleği döner
 *   - Değilse yeniden fit edilir ve candidates raporu da saklanır
 */
export function useSurfaceModel({ importedPoints, gnssSamplesRef }: Options) {
  const lastComputeAtRef = useRef<number>(0);
  const cachedModelRef = useRef<SurfaceModel | null>(null);
  const cachedReportRef = useRef<SurfaceFitReport>({ winner: null, candidates: [] });
  const prevAnchorKeyRef = useRef<string>('');
  const speedMpsRef = useRef<number>(0);

  // importedPoints değişirse cache'i geçersiz kıl
  useEffect(() => {
    cachedModelRef.current = null;
    cachedReportRef.current = { winner: null, candidates: [] };
    lastComputeAtRef.current = 0;
  }, [importedPoints]);

  const invalidate = useCallback(() => {
    cachedModelRef.current = null;
    cachedReportRef.current = { winner: null, candidates: [] };
    lastComputeAtRef.current = 0;
  }, []);

  const updateSpeed = useCallback((speedMps: number) => {
    speedMpsRef.current = speedMps;
  }, []);

  const compute = useCallback((anchor: GeoPoint3D, current: GeoPoint3D): SurfaceModel | null => {
    const now = Date.now();
    const anchorKey = `${anchor.lat.toFixed(7)}:${anchor.lon.toFixed(7)}`;

    if (anchorKey !== prevAnchorKeyRef.current) {
      cachedModelRef.current = null;
      cachedReportRef.current = { winner: null, candidates: [] };
      lastComputeAtRef.current = 0;
      prevAnchorKeyRef.current = anchorKey;
    }

    const spd = speedMpsRef.current;
    const cacheMs = spd > 3 ? 200 : spd > 0.8 ? 350 : 700;

    if (cachedModelRef.current && now - lastComputeAtRef.current <= cacheMs) {
      return cachedModelRef.current;
    }

    const report = fitSurfaceModelWithReport(anchor, current, importedPoints, gnssSamplesRef.current);
    cachedModelRef.current = report.winner;
    cachedReportRef.current = report;
    lastComputeAtRef.current = now;
    return report.winner;
  }, [importedPoints, gnssSamplesRef]);

  const getReport = useCallback((): SurfaceFitReport => cachedReportRef.current, []);

  return { compute, invalidate, updateSpeed, getReport };
}
