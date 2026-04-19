import React, { useEffect, useRef, useMemo, useState, memo } from 'react';
import { MapContainer, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Navigation } from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import { NMEAData } from '../lib/nmea';
import { ImportedPoint } from '../lib/ncnParser';
import OfflineMapLayer from './OfflineMapLayer';
import OfflineControl from './OfflineControl';
import { utmToWgs84 } from '../lib/geo';

// ─────────────────────────────────────────────────────────────────────────────
// İKONLAR — modül seviyesinde tanımlanır, her render'da yeniden oluşmaz
// ─────────────────────────────────────────────────────────────────────────────

const currentIcon = L.divIcon({
  className: 'custom-icon live-gps-icon',
  html: `
    <div style="position:relative;width:44px;height:44px;display:flex;align-items:center;justify-content:center;pointer-events:none;">
      <div style="position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle,rgba(34,211,238,0.45) 0%,rgba(59,130,246,0.08) 70%,transparent 100%);animation:map-pulse 2.2s ease-out infinite;"></div>
      <div style="position:absolute;width:26px;height:26px;border-radius:50%;background:conic-gradient(from 180deg,rgba(34,211,238,0.5),rgba(59,130,246,0.35),rgba(34,211,238,0.5));filter:blur(1px);opacity:0.85;"></div>
      <div style="position:relative;width:18px;height:18px;border-radius:50%;background:radial-gradient(circle at 32% 28%,#f0fdfa 0%,#67e8f9 45%,#3b82f6 100%);border:2.5px solid #ffffff;box-shadow:0 0 0 1px rgba(15,23,42,0.45),0 6px 14px rgba(34,211,238,0.55),0 2px 4px rgba(0,0,0,0.35);z-index:2;"></div>
      <div style="position:absolute;width:4px;height:4px;border-radius:50%;background:#fff;opacity:0.9;z-index:3;transform:translate(-4px,-4px);"></div>
    </div>`,
  iconSize: [44, 44],
  iconAnchor: [22, 22],
});

const targetPointIcon = L.divIcon({
  className: 'custom-icon reference-target-icon',
  html: `
    <div style="position:relative;width:52px;height:60px;display:flex;align-items:flex-end;justify-content:center;pointer-events:none;">
      <div style="position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:42px;height:42px;border-radius:50%;background:radial-gradient(circle,rgba(244,63,94,0.45) 0%,rgba(244,63,94,0.08) 70%,transparent 100%);animation:map-pulse-rose 2.4s ease-out infinite;"></div>
      <svg width="40" height="54" viewBox="0 0 40 54" style="position:relative;z-index:2;filter:drop-shadow(0 6px 12px rgba(0,0,0,0.45));" aria-hidden="true">
        <defs>
          <linearGradient id="ref-pin-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#fb7185"/>
            <stop offset="55%" stop-color="#f43f5e"/>
            <stop offset="100%" stop-color="#be123c"/>
          </linearGradient>
          <linearGradient id="ref-pin-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#bef264"/>
            <stop offset="100%" stop-color="#a3e635"/>
          </linearGradient>
        </defs>
        <path d="M20 2 C9 2 2 10 2 21 C2 34 20 52 20 52 C20 52 38 34 38 21 C38 10 31 2 20 2 Z"
          fill="url(#ref-pin-grad)" stroke="url(#ref-pin-ring)" stroke-width="2.2"/>
        <circle cx="20" cy="21" r="7" fill="#fff" opacity="0.96"/>
        <circle cx="20" cy="21" r="3.2" fill="#f43f5e"/>
      </svg>
    </div>`,
  iconSize: [52, 60],
  iconAnchor: [26, 54],
});

// ─────────────────────────────────────────────────────────────────────────────
// GPS MARKER — imperative Leaflet API ile güncellenir, React re-render olmaz
// ─────────────────────────────────────────────────────────────────────────────

function LiveGPSMarker({ currentPoint }: { currentPoint: NMEAData | null }) {
  const map = useMap();
  const markerRef = useRef<L.Marker | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!currentPoint || currentPoint.lat === 0) return;
    const latlng: L.LatLngTuple = [currentPoint.lat, currentPoint.lon];

    if (!markerRef.current) {
      markerRef.current = L.marker(latlng, { icon: currentIcon, zIndexOffset: 400, interactive: false })
        .addTo(map);
    } else {
      markerRef.current.setLatLng(latlng);
    }

    if (!initializedRef.current) {
      initializedRef.current = true;
      map.setView(latlng, 21, { animate: false });
    }
  }, [currentPoint, map]);

  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, [map]);

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// REFERANS (HEDEF) MARKER — sadece referencePoint değişince güncellenir
// ─────────────────────────────────────────────────────────────────────────────

function ReferenceMarker({
  referencePoint,
  currentPoint,
  label = 'Referans',
}: {
  referencePoint: NMEAData | null;
  currentPoint: NMEAData | null;
  label?: string;
}) {
  const map = useMap();
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    markerRef.current?.remove();
    markerRef.current = null;

    if (!referencePoint || referencePoint.lat === 0) return;

    let lat = referencePoint.lat;
    let lon = referencePoint.lon;

    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      const dom = currentPoint ? Math.round(currentPoint.lon / 3) * 3 : undefined;
      const wgs = utmToWgs84(lon, lat, dom);
      lat = wgs.lat;
      lon = wgs.lon;
    }

    const safeLabel = String(label).replace(/</g, '&lt;');
    const popup = `
      <div style="text-align:center;font-family:ui-sans-serif,system-ui,sans-serif;min-width:140px">
        <div style="background:linear-gradient(135deg,#fb7185,#f43f5e);color:#fff;font-weight:700;font-size:10.5px;letter-spacing:0.08em;padding:3px 10px;border-radius:999px;display:inline-block;margin-bottom:6px;text-transform:uppercase;box-shadow:0 4px 10px rgba(244,63,94,0.35)">Aktif Hedef</div>
        <strong style="display:block;color:#0f172a;font-size:14px">${safeLabel}</strong>
        <div style="font-size:11px;color:#475569;margin-top:4px;font-variant-numeric:tabular-nums">Z: ${referencePoint.alt.toFixed(3)} m</div>
      </div>`;

    markerRef.current = L.marker([lat, lon], { icon: targetPointIcon, zIndexOffset: 300 })
      .bindPopup(popup)
      .addTo(map);
  }, [referencePoint, currentPoint, label, map]);

  useEffect(() => {
    return () => { markerRef.current?.remove(); markerRef.current = null; };
  }, [map]);

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POLYLINE — hedef ile mevcut arası çizgi
// ─────────────────────────────────────────────────────────────────────────────

function GuidanceLine({
  currentPoint,
  referencePoint,
}: {
  currentPoint: NMEAData | null;
  referencePoint: NMEAData | null;
}) {
  const map = useMap();
  const lineRef = useRef<L.Polyline | null>(null);

  useEffect(() => {
    if (!currentPoint || !referencePoint || currentPoint.lat === 0 || referencePoint.lat === 0) {
      lineRef.current?.setLatLngs([]);
      return;
    }

    let refLat = referencePoint.lat;
    let refLon = referencePoint.lon;
    if (Math.abs(refLat) > 90 || Math.abs(refLon) > 180) {
      const dom = Math.round(currentPoint.lon / 3) * 3;
      const wgs = utmToWgs84(refLon, refLat, dom);
      refLat = wgs.lat; refLon = wgs.lon;
    }

    const positions: L.LatLngTuple[] = [
      [currentPoint.lat, currentPoint.lon],
      [refLat, refLon],
    ];

    if (!lineRef.current) {
      lineRef.current = L.polyline(positions, {
        color: '#f43f5e', dashArray: '6, 9', weight: 2.5, opacity: 0.85,
      }).addTo(map);
    } else {
      lineRef.current.setLatLngs(positions);
    }
  }, [currentPoint, referencePoint, map]);

  useEffect(() => {
    return () => { lineRef.current?.remove(); lineRef.current = null; };
  }, [map]);

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJE NOKTALARI — layer reuse: markerlar bir kez oluşur, sonra sadece güncellenir
// ─────────────────────────────────────────────────────────────────────────────

interface DisplayPoint extends ImportedPoint {
  displayLat: number;
  displayLon: number;
  isProjected: boolean;
}

const scheduleIdle: (cb: () => void) => void =
  typeof requestIdleCallback !== 'undefined'
    ? (cb) => requestIdleCallback(cb, { timeout: 500 })
    : (cb) => setTimeout(cb, 16);

const CHUNK_SIZE = 40;
const MAX_VISIBLE_POINTS = 1200;

// Stil sabitleri — normal vs seçili marker
const NORMAL_STYLE: L.CircleMarkerOptions = {
  radius: 6,
  color: '#ffffff',
  weight: 1.5,
  fillColor: '#6366f1',
  fillOpacity: 0.92,
};
const SELECTED_STYLE: L.CircleMarkerOptions = {
  radius: 10,
  color: '#bef264',
  weight: 3,
  fillColor: '#f43f5e',
  fillOpacity: 1,
};
const HOVER_STYLE: L.CircleMarkerOptions = {
  radius: 8,
  color: '#ffffff',
  weight: 2,
  fillColor: '#6366f1',
  fillOpacity: 1,
};

function isReferenceMatch(pt: DisplayPoint, ref: NMEAData | null): boolean {
  if (!ref) return false;
  return (
    Math.abs(pt.lat - ref.lat) < 0.0001 &&
    Math.abs(pt.lon - ref.lon) < 0.0001
  );
}

function createPointPopupContent(pt: DisplayPoint, onSelect: () => void): HTMLElement {
  const content = document.createElement('div');
  content.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
  content.style.minWidth = '180px';

  const title = document.createElement('strong');
  title.style.color = '#0f172a';
  title.style.fontSize = '14px';
  title.style.fontWeight = '700';
  title.textContent = pt.name;
  content.appendChild(title);

  const details = document.createElement('div');
  details.style.fontSize = '11px';
  details.style.color = '#475569';
  details.style.marginTop = '8px';
  details.style.padding = '8px 10px';
  details.style.background = 'linear-gradient(135deg,#f8fafc,#eef2ff)';
  details.style.borderRadius = '10px';
  details.style.border = '1px solid #e2e8f0';
  details.style.fontVariantNumeric = 'tabular-nums';

  const z = document.createElement('span');
  z.style.fontWeight = '700';
  z.style.color = '#0f172a';
  z.style.display = 'block';
  z.style.marginBottom = '4px';
  z.textContent = `Z: ${pt.alt.toFixed(3)} m`;
  details.appendChild(z);

  const coords = document.createElement('span');
  coords.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  coords.style.whiteSpace = 'pre-line';
  coords.style.fontSize = '10.5px';
  coords.textContent = pt.isProjected
    ? `Y: ${pt.lon.toFixed(3)}\nX: ${pt.lat.toFixed(3)}`
    : `Lat: ${pt.lat.toFixed(5)}\nLon: ${pt.lon.toFixed(5)}`;
  details.appendChild(coords);

  content.appendChild(details);

  const button = document.createElement('button');
  button.type = 'button';
  button.style.marginTop = '10px';
  button.style.width = '100%';
  button.style.background = 'linear-gradient(135deg,#fb7185,#f43f5e)';
  button.style.color = 'white';
  button.style.border = 'none';
  button.style.borderRadius = '10px';
  button.style.padding = '9px';
  button.style.fontSize = '13px';
  button.style.fontWeight = '700';
  button.style.letterSpacing = '0.02em';
  button.style.cursor = 'pointer';
  button.style.boxShadow = '0 6px 14px rgba(244,63,94,0.35)';
  button.textContent = 'Hedef Seç (Stakeout)';
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    onSelect();
  });
  content.appendChild(button);

  return content;
}

function bboxKey(pts: DisplayPoint[]): string {
  if (pts.length === 0) return '';
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (p.displayLat < minLat) minLat = p.displayLat;
    if (p.displayLat > maxLat) maxLat = p.displayLat;
    if (p.displayLon < minLon) minLon = p.displayLon;
    if (p.displayLon > maxLon) maxLon = p.displayLon;
  }
  return `${pts.length}:${minLat.toFixed(6)},${minLon.toFixed(6)},${maxLat.toFixed(6)},${maxLon.toFixed(6)}`;
}

function ProjectPoints({
  displayPoints,
  referencePoint,
  onSelectPoint,
}: {
  displayPoints: DisplayPoint[];
  referencePoint: NMEAData | null;
  onSelectPoint?: (pt: ImportedPoint) => void;
}) {
  const map = useMap();
  const [viewportVersion, setViewportVersion] = useState(0);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Map<string, L.CircleMarker>>(new Map());
  const pointDataRef = useRef<Map<string, DisplayPoint>>(new Map());
  const selectedKeyRef = useRef<string | null>(null);
  const lastBboxKeyRef = useRef<string>('');
  const runTokenRef = useRef(0);
  const onSelectPointRef = useRef(onSelectPoint);

  // onSelectPoint ref'ini güncel tut — useCallback'tan bağımsız
  useEffect(() => {
    onSelectPointRef.current = onSelectPoint;
  }, [onSelectPoint]);

  useEffect(() => {
    const refreshViewport = () => setViewportVersion((v) => v + 1);
    map.on('moveend zoomend resize', refreshViewport);
    return () => {
      map.off('moveend zoomend resize', refreshViewport);
    };
  }, [map]);

  const renderPoints = useMemo<DisplayPoint[]>(() => {
    if (displayPoints.length <= MAX_VISIBLE_POINTS) return displayPoints;

    const paddedBounds = map.getBounds().pad(0.25);
    const inView = displayPoints.filter((pt) => paddedBounds.contains([pt.displayLat, pt.displayLon]));

    if (inView.length <= MAX_VISIBLE_POINTS) return inView;

    const stride = Math.max(1, Math.ceil(inView.length / MAX_VISIBLE_POINTS));
    const sampled: DisplayPoint[] = [];
    for (let i = 0; i < inView.length; i += stride) sampled.push(inView[i]);
    return sampled;
  }, [displayPoints, map, viewportVersion]);

  // ── Ana effect: layer reuse — displayPoints değişince sadece diff uygula ──
  useEffect(() => {
    const myToken = ++runTokenRef.current;

    if (!layerGroupRef.current) {
      layerGroupRef.current = L.layerGroup().addTo(map);
    }
    const lg = layerGroupRef.current;
    const cache = markersRef.current;
    const data = pointDataRef.current;

    // Yeni display haritası
    const nextKeys = new Set<string>();
    for (const pt of renderPoints) nextKeys.add(pt.name);

    // Kaldırılan noktaları temizle
    for (const [key, marker] of cache) {
      if (!nextKeys.has(key)) {
        lg.removeLayer(marker);
        cache.delete(key);
        data.delete(key);
      }
    }

    // fitBounds: yalnızca bbox anlamlı değiştiyse (ilk yükleme veya yeni nokta seti)
    const nextBboxKey = bboxKey(displayPoints);
    const shouldFit = displayPoints.length > 0 && nextBboxKey !== lastBboxKeyRef.current;

    if (shouldFit) {
      lastBboxKeyRef.current = nextBboxKey;
      const lats = displayPoints.map(p => p.displayLat);
      const lons = displayPoints.map(p => p.displayLon);
      map.fitBounds(
        L.latLngBounds([Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]),
        { padding: [60, 60], maxZoom: 21, animate: false }
      );
    }

    // Eklenecek noktaları topla (cache'de olmayanlar)
    const toAdd: DisplayPoint[] = [];
    for (const pt of renderPoints) {
      const existing = cache.get(pt.name);
      if (!existing) {
        toAdd.push(pt);
      } else {
        // Koordinat değiştiyse (surface layer toggle) setLatLng
        const prev = data.get(pt.name);
        if (!prev || prev.displayLat !== pt.displayLat || prev.displayLon !== pt.displayLon) {
          existing.setLatLng([pt.displayLat, pt.displayLon]);
        }
      }
      data.set(pt.name, pt);
    }

    // ── CHUNKED LOADING — sadece yeni noktalar için ─────────────────────────
    let idx = 0;
    const addNextChunk = () => {
      if (runTokenRef.current !== myToken || !lg) return;
      const end = Math.min(idx + CHUNK_SIZE, toAdd.length);
      for (let i = idx; i < end; i++) {
        const pt = toAdd[i];
        const isSelected = isReferenceMatch(pt, referencePoint);
        const style = isSelected ? SELECTED_STYLE : NORMAL_STYLE;

        const circle = L.circleMarker([pt.displayLat, pt.displayLon], style).addTo(lg);

        circle.on('click', () => {
          const current = pointDataRef.current.get(pt.name) ?? pt;
          const content = createPointPopupContent(current, () => {
            onSelectPointRef.current?.(current);
            map.closePopup();
          });
          L.popup({ maxWidth: 240 })
            .setLatLng([current.displayLat, current.displayLon])
            .setContent(content)
            .openOn(map);
        });

        circle.on('mouseover', () => {
          const selected = selectedKeyRef.current === pt.name;
          if (!selected) circle.setStyle(HOVER_STYLE);
        });
        circle.on('mouseout', () => {
          const selected = selectedKeyRef.current === pt.name;
          if (!selected) circle.setStyle(NORMAL_STYLE);
        });

        cache.set(pt.name, circle);
        if (isSelected) {
          selectedKeyRef.current = pt.name;
          circle.bringToFront();
        }
      }
      idx = end;
      if (idx < toAdd.length) scheduleIdle(addNextChunk);
    };

    if (toAdd.length > 0) scheduleIdle(addNextChunk);

    return () => {
      // Pending chunks bump detection via runTokenRef mismatch
    };
  }, [displayPoints, renderPoints, map]);

  // ── Referans değişim effect'i: sadece eski/yeni seçili markerın stilini güncelle ──
  useEffect(() => {
    const cache = markersRef.current;
    const data = pointDataRef.current;

    // Yeni seçili key'i bul
    let newKey: string | null = null;
    if (referencePoint) {
      for (const [key, pt] of data) {
        if (isReferenceMatch(pt, referencePoint)) {
          newKey = key;
          break;
        }
      }
    }

    const prevKey = selectedKeyRef.current;
    if (prevKey === newKey) return;

    // Eski seçili marker'ı normal stile çevir
    if (prevKey) {
      const prevMarker = cache.get(prevKey);
      if (prevMarker) prevMarker.setStyle(NORMAL_STYLE);
    }
    // Yeni seçili marker'ı vurgulu stile çevir
    if (newKey) {
      const nextMarker = cache.get(newKey);
      if (nextMarker) {
        nextMarker.setStyle(SELECTED_STYLE);
        nextMarker.bringToFront();
      }
    }
    selectedKeyRef.current = newKey;
  }, [referencePoint]);

  // Unmount temizliği
  useEffect(() => {
    return () => {
      runTokenRef.current++;
      layerGroupRef.current?.remove();
      layerGroupRef.current = null;
      markersRef.current.clear();
      pointDataRef.current.clear();
      selectedKeyRef.current = null;
      lastBboxKeyRef.current = '';
    };
  }, [map]);

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RECENTER BUTTON
// ─────────────────────────────────────────────────────────────────────────────

function RecenterButton({ currentPoint }: { currentPoint: NMEAData | null }) {
  const map = useMap();
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (currentPoint && currentPoint.lat !== 0) {
          map.setView([currentPoint.lat, currentPoint.lon], 21, { animate: true });
        }
      }}
      className="absolute bottom-6 right-6 z-[1000] bg-white p-3 rounded-full shadow-xl border border-slate-200 hover:bg-slate-50 transition-all text-slate-700 hover:text-sky-600 focus:outline-none"
      title="Mevcut Konuma Odaklan"
    >
      <Navigation className="w-5 h-5 fill-current" />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ANA MAP VIEW — React.memo ile gereksiz re-render engellenir
// ─────────────────────────────────────────────────────────────────────────────

interface MapViewProps {
  currentPoint: NMEAData | null;
  referencePoint: NMEAData | null;
  referenceLabel?: string;
  importedPoints: ImportedPoint[];
  surfaceAdjustedPoints?: ImportedPoint[];
  showSurfaceLayer?: boolean;
  onToggleSurfaceLayer?: (v: boolean) => void;
  onSelectPoint?: (pt: ImportedPoint) => void;
}

function MapView({
  currentPoint,
  referencePoint,
  referenceLabel,
  importedPoints,
  surfaceAdjustedPoints,
  showSurfaceLayer = false,
  onToggleSurfaceLayer,
  onSelectPoint,
}: MapViewProps) {
  const sourcePoints =
    showSurfaceLayer && surfaceAdjustedPoints && surfaceAdjustedPoints.length > 0
      ? surfaceAdjustedPoints
      : importedPoints;
  const canShowSurfaceLayer = Boolean(surfaceAdjustedPoints && surfaceAdjustedPoints.length > 0);
  const currentDom =
    currentPoint && Math.abs(currentPoint.lon) <= 180
      ? Math.round(currentPoint.lon / 3) * 3
      : undefined;

  const displayPoints = useMemo<DisplayPoint[]>(() => {
    return sourcePoints.map((pt) => {
      if (Math.abs(pt.lat) > 90 || Math.abs(pt.lon) > 180) {
        const { lat, lon } = utmToWgs84(pt.lon, pt.lat, currentDom);
        return { ...pt, displayLat: lat, displayLon: lon, isProjected: true };
      }
      return { ...pt, displayLat: pt.lat, displayLon: pt.lon, isProjected: false };
    });
  }, [sourcePoints, currentDom]);

  return (
    <div className="field-map-canvas w-full h-full overflow-hidden relative z-0">
      <MapContainer
        center={[39.0, 35.0]}
        zoom={5}
        maxZoom={22}
        preferCanvas={true}
        renderer={L.canvas()}
        style={{ width: '100%', height: '100%', zIndex: 0 }}
        zoomControl={true}
        attributionControl={false}
      >
        <OfflineMapLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <OfflineControl />

        {canShowSurfaceLayer && onToggleSurfaceLayer && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSurfaceLayer(!showSurfaceLayer);
            }}
            className={`absolute top-4 left-14 z-[1000] px-3 py-2 rounded-xl shadow-xl border text-xs font-bold transition-all ${
              showSurfaceLayer
                ? 'bg-emerald-500 text-white border-emerald-300'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
            title="Eğim düzeltmeli proje noktalarını göster"
          >
            Surface
          </button>
        )}

        <LiveGPSMarker currentPoint={currentPoint} />
        <ReferenceMarker referencePoint={referencePoint} currentPoint={currentPoint} label={referenceLabel} />
        <GuidanceLine currentPoint={currentPoint} referencePoint={referencePoint} />
        <ProjectPoints
          displayPoints={displayPoints}
          referencePoint={referencePoint}
          onSelectPoint={onSelectPoint}
        />
        <RecenterButton currentPoint={currentPoint} />
      </MapContainer>
    </div>
  );
}

// Tolerans: ~1mm yatay (≈ 1e-8 derece enlem), 1mm dikey
const LATLON_EPS = 1e-8;
const ALT_EPS = 0.001;

function samePoint(a: NMEAData | null, b: NMEAData | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.lat - b.lat) < LATLON_EPS &&
    Math.abs(a.lon - b.lon) < LATLON_EPS &&
    Math.abs(a.alt - b.alt) < ALT_EPS
  );
}

export default memo(MapView, (prev, next) => {
  return (
    samePoint(prev.currentPoint, next.currentPoint) &&
    samePoint(prev.referencePoint, next.referencePoint) &&
    prev.referenceLabel === next.referenceLabel &&
    prev.importedPoints === next.importedPoints &&
    prev.surfaceAdjustedPoints === next.surfaceAdjustedPoints &&
    prev.showSurfaceLayer === next.showSurfaceLayer &&
    prev.onSelectPoint === next.onSelectPoint &&
    prev.onToggleSurfaceLayer === next.onToggleSurfaceLayer
  );
});
