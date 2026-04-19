import proj4 from 'proj4';

// ─────────────────────────────────────────────────────────────────────────────
// TEMEL TİPLER
// ─────────────────────────────────────────────────────────────────────────────

/** [Easting/X, Northing/Y, Elevation/Z] — metre cinsinden metrik nokta */
export type Point3D = [number, number, number];

export interface GeoPoint3D {
  lat: number; // WGS84 enlem VEYA UTM/ITRF Northing
  lon: number; // WGS84 boylam VEYA UTM/ITRF Easting
  alt: number; // Elipsoidal yükseklik (metre)
}

export interface MetricContext {
  mode: 'projected' | 'local';
  dom?: number;
  originLat: number;
  originLon: number;
}

/**
 * En Küçük Kareler düzlem uydurma sonucu.
 */
export interface PlaneFitResult {
  /** Birim normal vektör — her zaman nz > 0 (yukarı bakan) */
  normal: Point3D;
  /** Düzlem üzerinde bir referans nokta (nokta kümesinin ağırlık merkezi) */
  planePoint: Point3D;
  /** Eğim açısı: yatay düzlemden kaç derece sapıyor */
  slopeDeg: number;
  /** Artık (residual) RMS — düzlem uydurma kalitesi, metre */
  residualRMS: number;
  /** Hesaplamada kullanılan nokta sayısı */
  pointsUsed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// KOORDİNAT SİSTEMİ YARDIMCILARI
// ─────────────────────────────────────────────────────────────────────────────

const DEGREE_TO_METER = 111_320; // 1° enlem ≈ 111 320 m

/** ITRF/UTM 3°-dilim TM projeksiyonu (false_easting = 500 000 m) */
function projectionString(dom: number): string {
  return `+proj=tmerc +lat_0=0 +lon_0=${dom} +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
}

/**
 * Koordinat değerlerinin projected (UTM/ITRF) mi yoksa coğrafi (WGS84 °) mi
 * olduğunu tespit eder.
 *  - WGS84:    lat ∈ [-90, 90],  lon ∈ [-180, 180]
 *  - Projected: değerler bu aralıkların çok dışındadır (Northing ≈ 4 200 000)
 */
export function isProjectedCoordinate(lat: number, lon: number): boolean {
  return Math.abs(lat) > 90 || Math.abs(lon) > 180;
}

/** Easting değerinden DOM (Dilim Orta Meridyeni) otomatik tespiti */
function detectDomFromEasting(easting: number): { dom: number; stripped: number } {
  if (easting > 1_000_000) {
    const dom = Math.floor(easting / 1_000_000);
    return { dom, stripped: easting % 1_000_000 };
  }
  return { dom: 0, stripped: easting };
}

/**
 * DOM tahminini WGS84 sonucunu Türkiye sınırları içinde kontrol ederek doğrular.
 * Türkiye: lat ∈ [36°, 43°], lon ∈ [25°, 46°]
 * Sonuç bu aralıkta değilse komşu dilimleri de dener.
 */
export function utmToWgs84Validated(
  easting: number,
  northing: number,
  preferredDom: number
): { lat: number; lon: number; dom: number } {
  const domCandidates = [preferredDom, preferredDom - 3, preferredDom + 3].filter(d => d >= 24 && d <= 48);
  for (const dom of domCandidates) {
    try {
      const [lon, lat] = proj4(projectionString(dom), 'EPSG:4326', [easting, northing]);
      if (lat >= 35 && lat <= 44 && lon >= 24 && lon <= 47) {
        return { lat, lon, dom };
      }
    } catch { /* devam */ }
  }
  // Fallback: tercih edilen DOM ile dön
  const [lon, lat] = proj4(projectionString(preferredDom), 'EPSG:4326', [easting, northing]);
  return { lat, lon, dom: preferredDom };
}

/** WGS84 boylamından DOM tespiti (3°-dilimler, Türkiye: 27–42) */
function detectDomFromLon(lon: number): number {
  return Math.round(lon / 3) * 3;
}

// ─────────────────────────────────────────────────────────────────────────────
// KOORDİNAT DÖNÜŞÜM
// ─────────────────────────────────────────────────────────────────────────────

export function utmToWgs84(
  easting: number,
  northing: number,
  knownDom?: number
): { lat: number; lon: number } {
  let dom = knownDom ?? 0;
  let e = easting;
  if (!dom) {
    const d = detectDomFromEasting(easting);
    if (d.dom) {
      dom = d.dom;
      e = d.stripped;
    } else {
      // Prefix'siz easting: Kuzey enleminden tahmin
      // Northing 3.6M-4.8M → Türkiye → varsayılan 33, doğrula
      const { lat, lon, dom: resolvedDom } = utmToWgs84Validated(easting, northing, 33);
      return { lat, lon };
    }
  }
  const [lon, lat] = proj4(projectionString(dom), 'EPSG:4326', [e, northing]);
  return { lat, lon };
}

export function createMetricContext(
  reference: GeoPoint3D,
  current: GeoPoint3D
): MetricContext {
  const isRefProj = isProjectedCoordinate(reference.lat, reference.lon);
  const isCurProj = isProjectedCoordinate(current.lat, current.lon);

  if (isRefProj || isCurProj) {
    let dom: number | undefined;
    if (!isRefProj) {
      dom = detectDomFromLon(reference.lon);
    } else if (!isCurProj) {
      dom = detectDomFromLon(current.lon);
    } else {
      dom = detectDomFromEasting(reference.lon).dom || 33;
    }
    return { mode: 'projected', dom, originLat: reference.lat, originLon: reference.lon };
  }

  return { mode: 'local', originLat: reference.lat, originLon: reference.lon };
}

export function toMetricPoint(point: GeoPoint3D, context: MetricContext): Point3D {
  const isProj = isProjectedCoordinate(point.lat, point.lon);

  if (context.mode === 'projected') {
    if (isProj) {
      const { dom, stripped } = detectDomFromEasting(point.lon);
      return [dom ? stripped : point.lon, point.lat, point.alt];
    }
    if (!context.dom) throw new Error('Projected modda DOM değeri eksik.');
    const [e, n] = proj4('EPSG:4326', projectionString(context.dom), [point.lon, point.lat]);
    return [e, n, point.alt];
  }

  if (isProj) throw new Error('Local WGS84 modunda projected koordinat bulunamaz.');
  const originLatRad = context.originLat * (Math.PI / 180);
  const east = (point.lon - context.originLon) * DEGREE_TO_METER * Math.cos(originLatRad);
  const north = (point.lat - context.originLat) * DEGREE_TO_METER;
  return [east, north, point.alt];
}

// ─────────────────────────────────────────────────────────────────────────────
// EN KÜÇÜK KARELER DÜZLEM UYDURMA  (Least Squares Plane Fit)
// ─────────────────────────────────────────────────────────────────────────────
//
// Model: z = a·x + b·y + c
//
// Normal denklem sistemi (3×3):
//   [Σx²  Σxy  Σx ] [a]   [Σxz]
//   [Σxy  Σy²  Σy ] [b] = [Σyz]
//   [Σx   Σy   N  ] [c]   [Σz ]
//
// Gauss eliminasyonu + satır pivotlaması ile çözülür.
// Normal vektör: n = normalize([-a, -b, 1]), nz > 0 tercih edilir.
// ─────────────────────────────────────────────────────────────────────────────

export function leastSquaresPlaneFit(
  points: Point3D[],
  minPoints = 3
): PlaneFitResult | null {
  const N = points.length;
  if (N < minPoints) return null;

  // Sayısal kararlılık için merkezi çıkar
  let cx = 0, cy = 0, cz = 0;
  for (const [x, y, z] of points) { cx += x; cy += y; cz += z; }
  cx /= N; cy /= N; cz /= N;

  let Sxx = 0, Sxy = 0, Sxz = 0, Syy = 0, Syz = 0, Sx = 0, Sy = 0, Sz = 0;
  for (const [X, Y, Z] of points) {
    const x = X - cx, y = Y - cy, z = Z - cz;
    Sxx += x * x; Sxy += x * y; Sxz += x * z;
    Syy += y * y; Syz += y * z;
    Sx += x; Sy += y; Sz += z;
  }

  // Genişletilmiş matris [A | b]
  const A: number[][] = [
    [Sxx, Sxy, Sx, Sxz],
    [Sxy, Syy, Sy, Syz],
    [Sx,  Sy,  N,  Sz ],
  ];

  // Gauss eliminasyonu
  for (let col = 0; col < 3; col++) {
    let maxVal = Math.abs(A[col][col]), maxRow = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(A[row][col]) > maxVal) { maxVal = Math.abs(A[row][col]); maxRow = row; }
    }
    if (maxVal < 1e-10) return null; // Singular — collinear nokta kümesi

    [A[col], A[maxRow]] = [A[maxRow], A[col]];
    for (let row = col + 1; row < 3; row++) {
      const f = A[row][col] / A[col][col];
      for (let k = col; k <= 3; k++) A[row][k] -= f * A[col][k];
    }
  }

  // Geri yerine koyma
  const v = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = A[i][3];
    for (let j = i + 1; j < 3; j++) s -= A[i][j] * v[j];
    v[i] = s / A[i][i];
  }

  const [a, b] = v;
  const len = Math.sqrt(a * a + b * b + 1);
  const normal: Point3D = [-a / len, -b / len, 1 / len];
  if (normal[2] < 0) { normal[0] = -normal[0]; normal[1] = -normal[1]; normal[2] = -normal[2]; }

  const safeNz = Math.min(1, Math.max(0, Math.abs(normal[2])));
  const slopeDeg = (Math.acos(safeNz) * 180) / Math.PI;

  const planePoint: Point3D = [cx, cy, cz];

  // Residual RMS
  let sumSq = 0;
  for (const p of points) {
    const predicted = planePoint[2]
      - (normal[0] * (p[0] - planePoint[0]) + normal[1] * (p[1] - planePoint[1])) / normal[2];
    sumSq += (p[2] - predicted) ** 2;
  }

  return { normal, planePoint, slopeDeg, residualRMS: Math.sqrt(sumSq / N), pointsUsed: N };
}

// ─────────────────────────────────────────────────────────────────────────────
// TLS DÜZLEM UYDURMA — Jacobi Özdeğer Ayrışımı (SVD tabanlı)
//
// z=f(x,y) varsayımı OLMADAN çalışır.
// Kovaryans matrisinin en küçük özdeğerine karşılık gelen
// özvektör = düzlem normali.
// Dikey veya çok dik eğimlerde leastSquaresPlaneFit'e göre
// çok daha sağlamdır.
// ─────────────────────────────────────────────────────────────────────────────

export function tlsPlaneFit(
  points: Point3D[],
  minPoints = 3
): PlaneFitResult | null {
  const N = points.length;
  if (N < minPoints) return null;

  // 1. Ağırlık merkezi
  let cx = 0, cy = 0, cz = 0;
  for (const [x, y, z] of points) { cx += x; cy += y; cz += z; }
  cx /= N; cy /= N; cz /= N;

  // 2. 3×3 kovaryans matrisi
  let C00=0,C01=0,C02=0,C11=0,C12=0,C22=0;
  for (const [X, Y, Z] of points) {
    const dx=X-cx, dy=Y-cy, dz=Z-cz;
    C00+=dx*dx; C01+=dx*dy; C02+=dx*dz;
    C11+=dy*dy; C12+=dy*dz; C22+=dz*dz;
  }

  // 3. Jacobi iterasyonu — 3×3 simetrik matris
  const A: number[][] = [
    [C00, C01, C02],
    [C01, C11, C12],
    [C02, C12, C22],
  ];
  const V: number[][] = [[1,0,0],[0,1,0],[0,0,1]];

  for (let iter = 0; iter < 100; iter++) {
    // En büyük köşegen dışı eleman
    let maxOff = 0, p = 0, q = 1;
    for (let i = 0; i < 3; i++)
      for (let j = i+1; j < 3; j++)
        if (Math.abs(A[i][j]) > maxOff) { maxOff = Math.abs(A[i][j]); p = i; q = j; }
    if (maxOff < 1e-14) break;

    // Givens döndürme parametreleri
    const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
    const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(1 + theta*theta));
    const c = 1 / Math.sqrt(1 + t*t);
    const s = t * c;

    // A ← G^T A G
    const App = A[p][p], Aqq = A[q][q], Apq = A[p][q];
    A[p][p] = c*c*App - 2*s*c*Apq + s*s*Aqq;
    A[q][q] = s*s*App + 2*s*c*Apq + c*c*Aqq;
    A[p][q] = A[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      if (k === p || k === q) continue;
      const Akp = A[k][p], Akq = A[k][q];
      A[k][p] = A[p][k] = c*Akp - s*Akq;
      A[k][q] = A[q][k] = s*Akp + c*Akq;
    }
    // V ← V G
    for (let k = 0; k < 3; k++) {
      const Vkp = V[k][p], Vkq = V[k][q];
      V[k][p] = c*Vkp - s*Vkq;
      V[k][q] = s*Vkp + c*Vkq;
    }
  }

  // En küçük özdeğerin indeksi → normal
  let minIdx = 0;
  for (let i = 1; i < 3; i++) if (A[i][i] < A[minIdx][minIdx]) minIdx = i;

  let nx = V[0][minIdx], ny = V[1][minIdx], nz = V[2][minIdx];
  const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
  if (len < 1e-10) return null;
  nx /= len; ny /= len; nz /= len;
  if (nz < 0) { nx=-nx; ny=-ny; nz=-nz; }

  const normal: Point3D = [nx, ny, nz];
  const planePoint: Point3D = [cx, cy, cz];
  const safeNz = Math.min(1, Math.max(0, Math.abs(nz)));
  const slopeDeg = (Math.acos(safeNz) * 180) / Math.PI;

  // Residual RMS: düzleme dik mesafe
  let sumSq = 0;
  for (const [X, Y, Z] of points) {
    const d = (X-cx)*nx + (Y-cy)*ny + (Z-cz)*nz;
    sumSq += d*d;
  }

  return { normal, planePoint, slopeDeg, residualRMS: Math.sqrt(sumSq / N), pointsUsed: N };
}

// ─────────────────────────────────────────────────────────────────────────────
// KRİTİK FONKSİYON: HEDEF NOKTANIN Z DEĞERİNİ EĞİM DÜZLEMİNDEN HESAPLA
// ─────────────────────────────────────────────────────────────────────────────
//
// PROJE MANTIĞİ:
//   NCN dosyasındaki noktalar "düz zemin" varsayımıyla çizilmiş.
//   Gerçek arazi eğimli olduğu için, hedef noktanın Z değeri NCN'deki
//   tasarım kotundan değil, hesaplanan EĞİM DÜZLEMİNDEN alınmalıdır.
//
//   Düzlem denklemi: n · (p - p0) = 0
//   → z = p0.z - [nx·(x - p0.x) + ny·(y - p0.y)] / nz
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Eğim düzleminde verilen (x, y) konumundaki Z yüksekliğini interpolate eder.
 * nz sıfıra yakınsa (dikey düzlem gibi) null döner.
 */
export function interpolateZOnPlane(
  x: number,
  y: number,
  plane: PlaneFitResult
): number | null {
  const { normal: [nx, ny, nz], planePoint: [px, py, pz] } = plane;
  if (Math.abs(nz) < 1e-9) return null; // Dikey düzlem — interpolasyon imkansız
  return pz - (nx * (x - px) + ny * (y - py)) / nz;
}

/**
 * Hedef NCN noktasını eğim düzlemine "oturtур".
 *
 * - X, Y bileşenleri değişmez (planimetrik konum sabit).
 * - Z: NCN'deki tasarım kotundan değil, eğim düzleminin o (x,y)
 *   koordinatındaki yüksekliğinden hesaplanır.
 *
 * Bu fonksiyon projenin temel slope-correction mantığını uygular.
 *
 * @param targetMetric   Hedef NCN noktasının metrik koordinatı
 * @param plane          Araziden hesaplanan eğim düzlemi
 * @returns              Z'si eğimden hesaplanmış yeni Point3D
 */
export function transformTargetToSlope(
  targetMetric: Point3D,
  plane: PlaneFitResult
): Point3D {
  const z = interpolateZOnPlane(targetMetric[0], targetMetric[1], plane);
  // nz ≈ 0 (dikey düzlem) durumunda orijinal Z'yi koru
  return [targetMetric[0], targetMetric[1], z ?? targetMetric[2]];
}

// ─────────────────────────────────────────────────────────────────────────────
// DÜZLEM PROJEKSIYON (üzerine dik indir)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 3 nokta ile birim normal vektör hesaplar (çapraz çarpım yöntemi).
 * Noktalar collinear ise null döner.
 */
export function calculatePlane(
  p1: number[], p2: number[], p3: number[]
): Point3D | null {
  const v1: Point3D = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
  const v2: Point3D = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
  const nx = v1[1] * v2[2] - v1[2] * v2[1];
  const ny = v1[2] * v2[0] - v1[0] * v2[2];
  const nz = v1[0] * v2[1] - v1[1] * v2[0];
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!Number.isFinite(len) || len < 1e-9) return null;
  return [nx / len, ny / len, nz / len];
}

/** Noktayı düzleme dik olarak projekte eder: p' = p - (p-p0)·n * n */
export function projectPointToPlane(
  point: Point3D, planePoint: Point3D, normal: Point3D
): Point3D {
  const dot =
    (point[0] - planePoint[0]) * normal[0] +
    (point[1] - planePoint[1]) * normal[1] +
    (point[2] - planePoint[2]) * normal[2];
  return [point[0] - dot * normal[0], point[1] - dot * normal[1], point[2] - dot * normal[2]];
}

// ─────────────────────────────────────────────────────────────────────────────
// MESAFE HESAPLAMA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vincenty jeodesik mesafe — WGS84 elipsoidi üzerinde hassas yatay mesafe.
 * Haversine (küre) yerine elipsoidal model kullanır.
 * Hata payı ~0.3mm, Haversine'in uzun mesafedeki %0.5 hatasını giderir.
 * Çakışık noktalarda 0 döner, ıraksamada Haversine'e fallback yapar.
 */
function vincentyDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a = 6_378_137.0;          // WGS84 büyük yarı eksen
  const f = 1 / 298.257223563;   // WGS84 basıklık
  const b = (1 - f) * a;         // küçük yarı eksen

  const φ1 = lat1 * (Math.PI / 180);
  const φ2 = lat2 * (Math.PI / 180);
  const L  = (lon2 - lon1) * (Math.PI / 180);

  const U1 = Math.atan((1 - f) * Math.tan(φ1));
  const U2 = Math.atan((1 - f) * Math.tan(φ2));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

  let λ = L, λPrev = 0;
  let sinσ = 0, cosσ = 0, σ = 0;
  let sinα = 0, cos2α = 0, cos2σm = 0;

  for (let i = 0; i < 100; i++) {
    const sinλ = Math.sin(λ), cosλ = Math.cos(λ);
    const sinSqσ = (cosU2 * sinλ) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosλ) ** 2;
    sinσ = Math.sqrt(sinSqσ);
    if (sinσ === 0) return 0; // çakışık noktalar

    cosσ  = sinU1 * sinU2 + cosU1 * cosU2 * cosλ;
    σ     = Math.atan2(sinσ, cosσ);
    sinα  = (cosU1 * cosU2 * sinλ) / sinσ;
    cos2α = 1 - sinα ** 2;
    cos2σm = cos2α !== 0 ? cosσ - (2 * sinU1 * sinU2) / cos2α : 0;

    const C = (f / 16) * cos2α * (4 + f * (4 - 3 * cos2α));
    λPrev = λ;
    λ = L + (1 - C) * f * sinα *
      (σ + C * sinσ * (cos2σm + C * cosσ * (-1 + 2 * cos2σm ** 2)));

    if (Math.abs(λ - λPrev) < 1e-12) break;
  }

  // Yakınsama sağlanamadıysa Haversine ile devam et
  if (Math.abs(λ - λPrev) >= 1e-12) {
    const R = 6_378_137;
    const Δφ = (lat2 - lat1) * (Math.PI / 180);
    const Δλ = (lon2 - lon1) * (Math.PI / 180);
    const aa = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  }

  const u2 = cos2α * (a ** 2 - b ** 2) / b ** 2;
  const A_vin = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B_vin = u2 / 1024  * (256  + u2 * (-128 + u2 * (74  -  47 * u2)));
  const Δσ = B_vin * sinσ * (
    cos2σm + B_vin / 4 * (
      cosσ * (-1 + 2 * cos2σm ** 2) -
      B_vin / 6 * cos2σm * (-3 + 4 * sinσ ** 2) * (-3 + 4 * cos2σm ** 2)
    )
  );

  return b * A_vin * (σ - Δσ);
}

export interface DistanceResult {
  /** 2D yatay mesafe (plan), metre */
  horizontalDistance: number;
  /** Yükseklik farkı: ref.z − cur.z (pozitif = ref daha yüksek) */
  elevationDifference: number;
  /** 3D slope (eğimli) mesafe */
  realDistance: number;
  /** Kuzey bileşeni, metre (pozitif = ref kuzeyde) */
  deltaNorth: number;
  /** Doğu bileşeni, metre (pozitif = ref doğuda) */
  deltaEast: number;
  isProjected: boolean;
}

export function calculateDistanceFromMetricPoints(
  reference: Point3D,
  current: Point3D
): DistanceResult {
  const deltaEast  = reference[0] - current[0];
  const deltaNorth = reference[1] - current[1];
  const horiz = Math.sqrt(deltaEast * deltaEast + deltaNorth * deltaNorth);
  const elevDiff = reference[2] - current[2];
  return {
    horizontalDistance: horiz,
    elevationDifference: elevDiff,
    realDistance: Math.sqrt(horiz * horiz + elevDiff * elevDiff),
    deltaNorth, deltaEast, isProjected: true,
  };
}

export function calculateDistance(
  lat1: number, lon1: number, alt1: number,
  lat2: number, lon2: number, alt2: number
): DistanceResult {
  const isRef = isProjectedCoordinate(lat1, lon1);
  const isCur = isProjectedCoordinate(lat2, lon2);

  let horiz = 0, deltaNorth = 0, deltaEast = 0;

  if (isRef && isCur) {
    const e1 = detectDomFromEasting(lon1).dom ? lon1 % 1_000_000 : lon1;
    const e2 = detectDomFromEasting(lon2).dom ? lon2 % 1_000_000 : lon2;
    deltaNorth = lat1 - lat2; deltaEast = e1 - e2;
    horiz = Math.sqrt(deltaNorth ** 2 + deltaEast ** 2);
  } else if (isRef && !isCur) {
    const dom = detectDomFromLon(lon2);
    const [e2, n2] = proj4('EPSG:4326', projectionString(dom), [lon2, lat2]);
    const e1 = detectDomFromEasting(lon1).dom ? lon1 % 1_000_000 : lon1;
    deltaNorth = lat1 - n2; deltaEast = e1 - e2;
    horiz = Math.sqrt(deltaNorth ** 2 + deltaEast ** 2);
  } else if (!isRef && isCur) {
    const dom = detectDomFromLon(lon1);
    const [e1, n1] = proj4('EPSG:4326', projectionString(dom), [lon1, lat1]);
    const e2 = detectDomFromEasting(lon2).dom ? lon2 % 1_000_000 : lon2;
    deltaNorth = n1 - lat2; deltaEast = e1 - e2;
    horiz = Math.sqrt(deltaNorth ** 2 + deltaEast ** 2);
  } else {
    // Her ikisi WGS84 — Vincenty (WGS84 elipsoidi üzerine jeodesik mesafe)
    // Haversine'den çok daha doğru, özellikle uzun mesafelerde
    const latMid = (lat1 + lat2) / 2;
    deltaNorth = (lat1 - lat2) * DEGREE_TO_METER;
    deltaEast  = (lon1 - lon2) * DEGREE_TO_METER * Math.cos(latMid * (Math.PI / 180));
    horiz = vincentyDistance(lat1, lon1, lat2, lon2);
  }

  const elevDiff = alt1 - alt2;
  return {
    horizontalDistance: horiz,
    elevationDifference: elevDiff,
    realDistance: Math.sqrt(horiz * horiz + elevDiff * elevDiff),
    deltaNorth, deltaEast,
    isProjected: isRef || isCur,
  };
}

export type SurfaceSource = 'project' | 'gnss' | 'hybrid' | 'none';

export interface SurfaceModel {
  source: SurfaceSource;
  context: MetricContext;
  planePoint: Point3D;
  normal: Point3D;
  slopeDeg: number;
  /** Eğim yönü (azimut) — 0°=kuzey, 90°=doğu, saat yönünde. Yatay düzlemde 0. */
  slopeAzimuthDeg: number;
  residualRMS: number;
  pointsUsed: number;
  confidence: number;
  updatedAt: number;
}

/** Bir aday düzlem için skor bileşenleri — UI'da "neden bu kaynak seçildi" panelinde kullanılır. */
export interface SurfaceCandidateDebug {
  source: SurfaceSource;
  accepted: boolean;
  rejectionReason?: string;
  pointsUsed: number;
  slopeDeg: number;
  residualRMS: number;
  confidence: number;
  rmsScore: number;
  pointsScore: number;
  slopeScore: number;
  extentMeters: number;
}

export interface SurfaceFitReport {
  winner: SurfaceModel | null;
  candidates: SurfaceCandidateDebug[];
}

export interface StakeoutMetricsExtended extends DistanceResult {
  plane2dDistance: number;
  surface3dDistance: number;
  surfaceActive: boolean;
  surfaceSource: SurfaceSource;
  slopeDeg: number;
  residualRMS: number;
  confidence: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

interface ConfidenceBreakdown {
  rmsScore: number;
  pointsScore: number;
  slopeScore: number;
  total: number;
}

function confidenceBreakdown(fit: PlaneFitResult): ConfidenceBreakdown {
  const pointsScore = clamp01(fit.pointsUsed / 12);
  const rmsScore = clamp01(1 - fit.residualRMS / 0.05);
  const slopeScore = fit.slopeDeg <= 30 ? 1 : clamp01(1 - (fit.slopeDeg - 30) / 30);
  const total = clamp01(0.50 * rmsScore + 0.30 * pointsScore + 0.20 * slopeScore);
  return { rmsScore, pointsScore, slopeScore, total };
}

function calculateSurfaceConfidence(fit: PlaneFitResult): number {
  return confidenceBreakdown(fit).total;
}

function isAcceptableSurfaceFit(fit: PlaneFitResult): boolean {
  // Kabul eşiği: 35cm (telefon GPS için toleranslı), eğim < 75°
  return fit.residualRMS <= 0.35 && fit.slopeDeg <= 75;
}

/**
 * Eğim düzleminin yönü (azimut) — normal vektörünün yatay projeksiyonundan.
 * 0° = kuzey (yokuşun +Y'ye bakan yüzü), 90° = doğu, saat yönünde.
 * Yatay düzlemde (nx=ny=0) 0 döner.
 */
export function slopeAzimuthFromNormal(normal: Point3D): number {
  const [nx, ny] = normal;
  if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9) return 0;
  // Yokuşun aşağı doğru baktığı yön = -xy bileşeni
  const az = Math.atan2(-nx, -ny) * 180 / Math.PI;
  return (az + 360) % 360;
}

/**
 * Nokta bulutunun yatay bbox köşegen uzunluğu (metre).
 * Kolineer veya tek-noktaya sıkışmış kümelerde ~0 döner.
 */
export function pointCloudExtent(points: Point3D[]): number {
  if (points.length < 2) return 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Plane fit için minimum uzaysal yayılım — bunun altında fit güvenilmezdir. */
const MIN_EXTENT_METERS = 0.5;

function buildSurfaceModel(
  source: SurfaceSource,
  context: MetricContext,
  fit: PlaneFitResult
): SurfaceModel {
  return {
    source,
    context,
    planePoint: fit.planePoint,
    normal: fit.normal,
    slopeDeg: fit.slopeDeg,
    slopeAzimuthDeg: slopeAzimuthFromNormal(fit.normal),
    residualRMS: fit.residualRMS,
    pointsUsed: fit.pointsUsed,
    confidence: calculateSurfaceConfidence(fit),
    updatedAt: Date.now(),
  };
}

function toMetricPointsSafe(points: GeoPoint3D[], context: MetricContext): Point3D[] {
  const metricPoints: Point3D[] = [];
  for (const point of points) {
    try {
      metricPoints.push(toMetricPoint(point, context));
    } catch {
      // ignore incompatible point
    }
  }
  return metricPoints;
}

export function metricPointToGeo(
  point: Point3D,
  context: MetricContext,
  template?: GeoPoint3D
): GeoPoint3D {
  if (context.mode === 'projected') {
    const [easting, northing, alt] = point;

    if (template && isProjectedCoordinate(template.lat, template.lon)) {
      const domInfo = detectDomFromEasting(template.lon);
      const lon = domInfo.dom ? domInfo.dom * 1_000_000 + easting : easting;
      return { lat: northing, lon, alt };
    }

    if (!context.dom) {
      throw new Error('Projected mode requires DOM value.');
    }

    const [lon, lat] = proj4(projectionString(context.dom), 'EPSG:4326', [easting, northing]);
    return { lat, lon, alt };
  }

  const [east, north, alt] = point;
  const originLatRad = context.originLat * (Math.PI / 180);
  const lat = context.originLat + north / DEGREE_TO_METER;
  const lon = context.originLon + east / (DEGREE_TO_METER * Math.cos(originLatRad));
  return { lat, lon, alt };
}

interface CandidateResult {
  model: SurfaceModel | null;
  debug: SurfaceCandidateDebug;
}

function evaluateCandidate(
  source: SurfaceSource,
  context: MetricContext,
  points: Point3D[],
  minPoints: number
): CandidateResult {
  const extent = pointCloudExtent(points);
  const baseDebug = {
    source,
    pointsUsed: points.length,
    extentMeters: extent,
    slopeDeg: 0,
    residualRMS: 0,
    confidence: 0,
    rmsScore: 0,
    pointsScore: 0,
    slopeScore: 0,
  };

  if (points.length < minPoints) {
    return {
      model: null,
      debug: { ...baseDebug, accepted: false, rejectionReason: `< ${minPoints} nokta` },
    };
  }
  if (extent < MIN_EXTENT_METERS) {
    return {
      model: null,
      debug: {
        ...baseDebug,
        accepted: false,
        rejectionReason: `Yayilim cok dusuk (${extent.toFixed(2)}m)`,
      },
    };
  }

  const fit = tlsPlaneFit(points, minPoints) ?? leastSquaresPlaneFit(points, minPoints);
  if (!fit) {
    return {
      model: null,
      debug: { ...baseDebug, accepted: false, rejectionReason: 'Sayisal kosullar yetersiz' },
    };
  }

  const scores = confidenceBreakdown(fit);
  const debug: SurfaceCandidateDebug = {
    source,
    accepted: false,
    pointsUsed: fit.pointsUsed,
    extentMeters: extent,
    slopeDeg: fit.slopeDeg,
    residualRMS: fit.residualRMS,
    confidence: scores.total,
    rmsScore: scores.rmsScore,
    pointsScore: scores.pointsScore,
    slopeScore: scores.slopeScore,
  };

  if (!isAcceptableSurfaceFit(fit)) {
    debug.rejectionReason =
      fit.residualRMS > 0.35
        ? `RMS yuksek (${(fit.residualRMS * 100).toFixed(1)}cm > 35cm)`
        : `Egim asiri (${fit.slopeDeg.toFixed(1)}° > 75°)`;
    return { model: null, debug };
  }

  debug.accepted = true;
  return { model: buildSurfaceModel(source, context, fit), debug };
}

export function fitSurfaceModelWithReport(
  reference: GeoPoint3D,
  current: GeoPoint3D,
  projectPoints: GeoPoint3D[],
  gnssSamples: GeoPoint3D[]
): SurfaceFitReport {
  const context = createMetricContext(reference, current);

  let currentMetric: Point3D;
  try {
    currentMetric = toMetricPoint(current, context);
  } catch {
    return { winner: null, candidates: [] };
  }

  const projectMetric = toMetricPointsSafe(projectPoints, context);
  const gnssMetric = toMetricPointsSafe(gnssSamples, context);

  const nearestProjectMetric = projectMetric
    .map((metric) => {
      const dx = metric[0] - currentMetric[0];
      const dy = metric[1] - currentMetric[1];
      return { metric, d2: dx * dx + dy * dy };
    })
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, 8)
    .map((x) => x.metric);

  const results: CandidateResult[] = [];
  results.push(evaluateCandidate('project', context, nearestProjectMetric, 3));
  results.push(evaluateCandidate('gnss', context, gnssMetric, 6));
  results.push(evaluateCandidate('hybrid', context, [...nearestProjectMetric, ...gnssMetric], 6));

  const accepted = results.filter((r) => r.model).map((r) => r.model!) as SurfaceModel[];
  accepted.sort((a, b) => (b.confidence - a.confidence) || (a.residualRMS - b.residualRMS));

  return {
    winner: accepted[0] ?? null,
    candidates: results.map((r) => r.debug),
  };
}

export function fitSurfaceModel(
  reference: GeoPoint3D,
  current: GeoPoint3D,
  projectPoints: GeoPoint3D[],
  gnssSamples: GeoPoint3D[]
): SurfaceModel | null {
  return fitSurfaceModelWithReport(reference, current, projectPoints, gnssSamples).winner;
}

/**
 * Bölgesel (IDW-ağırlıklı) lokal düzlem:
 *   Her hedef nokta için kendi en yakın K komşusu alınır, mesafeye göre ağırlıklandırılır
 *   ve o noktaya özel bir düzlem fit edilir. Tek düzlemin aksine büyük projelerde
 *   arazinin lokal eğim değişimlerini yakalar.
 *
 * - Ağırlık: w_i = 1 / (d² + ε)
 * - En az `minPoints` komşu gerekir; yetersizse null döner.
 * - Z interpolasyonu: düzlem üzerinde hedefin (x,y)'sindeki değer.
 */
export function regionalPlaneZ(
  target: Point3D,
  neighbors: Point3D[],
  minPoints = 3,
  maxNeighbors = 8
): { z: number; plane: PlaneFitResult } | null {
  if (neighbors.length < minPoints) return null;

  const sorted = neighbors
    .map((p) => {
      const dx = p[0] - target[0];
      const dy = p[1] - target[1];
      return { p, d2: dx * dx + dy * dy };
    })
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, maxNeighbors);

  if (sorted.length < minPoints) return null;
  if (pointCloudExtent(sorted.map((x) => x.p)) < MIN_EXTENT_METERS) return null;

  // IDW ağırlıklı centroid ve kovaryans
  const eps = 1e-6;
  let wSum = 0, cx = 0, cy = 0, cz = 0;
  const weighted: Array<{ p: Point3D; w: number }> = [];
  for (const { p, d2 } of sorted) {
    const w = 1 / (d2 + eps);
    weighted.push({ p, w });
    wSum += w;
    cx += p[0] * w; cy += p[1] * w; cz += p[2] * w;
  }
  if (wSum < 1e-12) return null;
  cx /= wSum; cy /= wSum; cz /= wSum;

  // Ağırlıklı TLS: kovaryans matrisi w ile ölçeklenir
  let C00 = 0, C01 = 0, C02 = 0, C11 = 0, C12 = 0, C22 = 0;
  for (const { p, w } of weighted) {
    const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
    C00 += w * dx * dx; C01 += w * dx * dy; C02 += w * dx * dz;
    C11 += w * dy * dy; C12 += w * dy * dz; C22 += w * dz * dz;
  }

  const A: number[][] = [[C00, C01, C02], [C01, C11, C12], [C02, C12, C22]];
  const V: number[][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iter = 0; iter < 100; iter++) {
    let maxOff = 0, p = 0, q = 1;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      if (Math.abs(A[i][j]) > maxOff) { maxOff = Math.abs(A[i][j]); p = i; q = j; }
    }
    if (maxOff < 1e-14) break;
    const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
    const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(1 + theta * theta));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    const App = A[p][p], Aqq = A[q][q], Apq = A[p][q];
    A[p][p] = c * c * App - 2 * s * c * Apq + s * s * Aqq;
    A[q][q] = s * s * App + 2 * s * c * Apq + c * c * Aqq;
    A[p][q] = A[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      if (k === p || k === q) continue;
      const Akp = A[k][p], Akq = A[k][q];
      A[k][p] = A[p][k] = c * Akp - s * Akq;
      A[k][q] = A[q][k] = s * Akp + c * Akq;
    }
    for (let k = 0; k < 3; k++) {
      const Vkp = V[k][p], Vkq = V[k][q];
      V[k][p] = c * Vkp - s * Vkq;
      V[k][q] = s * Vkp + c * Vkq;
    }
  }

  let minIdx = 0;
  for (let i = 1; i < 3; i++) if (A[i][i] < A[minIdx][minIdx]) minIdx = i;
  let nx = V[0][minIdx], ny = V[1][minIdx], nz = V[2][minIdx];
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-10) return null;
  nx /= len; ny /= len; nz /= len;
  if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  if (Math.abs(nz) < 1e-9) return null;

  // Ağırlıklı residual RMS
  let wResid = 0, wTot = 0;
  for (const { p, w } of weighted) {
    const d = (p[0] - cx) * nx + (p[1] - cy) * ny + (p[2] - cz) * nz;
    wResid += w * d * d;
    wTot += w;
  }
  const rms = Math.sqrt(wResid / wTot);

  // Hedef noktanın (x,y) konumunda Z interpolasyonu
  const z = cz - (nx * (target[0] - cx) + ny * (target[1] - cy)) / nz;

  const plane: PlaneFitResult = {
    normal: [nx, ny, nz],
    planePoint: [cx, cy, cz],
    slopeDeg: (Math.acos(Math.min(1, Math.abs(nz))) * 180) / Math.PI,
    residualRMS: rms,
    pointsUsed: sorted.length,
  };
  return { z, plane };
}

export function calculateStakeoutMetrics(
  reference: GeoPoint3D,
  current: GeoPoint3D,
  surface: SurfaceModel | null
): StakeoutMetricsExtended {
  if (!surface) {
    const raw = calculateDistance(reference.lat, reference.lon, reference.alt, current.lat, current.lon, current.alt);
    return {
      ...raw,
      plane2dDistance: raw.horizontalDistance,
      surface3dDistance: raw.realDistance,
      surfaceActive: false,
      surfaceSource: 'none',
      slopeDeg: 0,
      residualRMS: 0,
      confidence: 0,
    };
  }

  try {
    const refMetric = toMetricPoint(reference, surface.context);
    const curMetric = toMetricPoint(current, surface.context);
    const projRef = projectPointToPlane(refMetric, surface.planePoint, surface.normal);
    const projCur = projectPointToPlane(curMetric, surface.planePoint, surface.normal);
    const corrected = calculateDistanceFromMetricPoints(projRef, projCur);

    return {
      ...corrected,
      plane2dDistance: corrected.horizontalDistance,
      surface3dDistance: corrected.realDistance,
      surfaceActive: true,
      surfaceSource: surface.source,
      slopeDeg: surface.slopeDeg,
      residualRMS: surface.residualRMS,
      confidence: surface.confidence,
    };
  } catch {
    const raw = calculateDistance(reference.lat, reference.lon, reference.alt, current.lat, current.lon, current.alt);
    return {
      ...raw,
      plane2dDistance: raw.horizontalDistance,
      surface3dDistance: raw.realDistance,
      surfaceActive: false,
      surfaceSource: 'none',
      slopeDeg: 0,
      residualRMS: 0,
      confidence: 0,
    };
  }
}
