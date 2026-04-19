// ─────────────────────────────────────────────
// NCN Dosya Ayrıştırıcı (Türkiye Haritacılık Standardı)
//
// NCN (Netcad Koordinat Noktası) formatları:
//
// Format A (Türk Kadastro / Haritacılık standardı):
//   NoktaAdi  Y(Easting)  X(Northing)  Z(Yükseklik)
//
// Format B (bazı projelerde):
//   NoktaAdi  X(Northing)  Y(Easting)  Z(Yükseklik)
//
// Format C (bazı eski sistemler):
//   NoktaNo  Kuzey(N)  Dogu(E)  Z
//
// Sütun ayırıcıları: boşluk, tab, virgül, noktalı virgül
// ─────────────────────────────────────────────

export interface ImportedPoint {
  name: string;
  lat: number;  // Northing (Y eksen) — WGS84 veya UTM
  lon: number;  // Easting  (X eksen) — WGS84 veya UTM
  alt: number;  // Z (yükseklik, metre)
}

export type NCNFormat = 'YXZ' | 'XYZ' | 'NEZ' | 'UNKNOWN';

export interface ParseNCNResult {
  points: ImportedPoint[];
  format: NCNFormat;
  warnings: string[];
}

/**
 * İki sayıyı analiz ederek hangisinin Northing (büyük), hangisinin Easting olduğunu tahmin eder.
 *
 * Türkiye için:
 *   Northing (Y) ≈ 4 200 000 – 4 700 000 (kuzeyin büyük değeri)
 *   Easting  (X) ≈ 300 000 – 800 000 veya 30xxx,xxx – 39xxx,xxx (dilim kodlu)
 *
 * WGS84 derece:
 *   Lat ≈ 36 – 42,  Lon ≈ 26 – 45
 */
function classifyCoordinatePair(a: number, b: number): { northing: number; easting: number } | null {
  const absA = Math.abs(a);
  const absB = Math.abs(b);

  // Her ikisi de WGS84 derece aralığında mı?
  if (absA <= 90 && absB <= 180) {
    // lat, lon sırası
    return { northing: a, easting: b };
  }

  // Projected: büyük olan Northing, küçük olan Easting (genel kural)
  if (absA > absB) {
    return { northing: a, easting: b }; // Format A: Y(Easting? hayır! büyük olan Northing)
  } else {
    return { northing: b, easting: a }; // Format B
  }
}

/**
 * Dosyanın ilk geçerli satırlarına bakarak NCN formatını otomatik tespit eder.
 */
function detectNCNFormat(lines: string[]): NCNFormat {
  // Sütun başlıklarını bul
  for (const line of lines.slice(0, 5)) {
    const lower = line.toLowerCase().trim();
    if (lower.includes('northing') || lower.includes('kuzey') || lower.includes(' n ')) return 'NEZ';
    if (lower.includes(',y,') || lower.includes('\ty\t') || lower.startsWith('y,') || lower.startsWith('y\t')) return 'YXZ';
    if (lower.includes(',x,') || lower.startsWith('x,') || lower.startsWith('x\t')) return 'XYZ';
  }

  // Sayısal değerlere bakarak anla
  for (const line of lines.slice(0, 20)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    const parts = trimmed.split(/[\s,;|]+/);
    if (parts.length < 4) continue;

    const val1 = parseFloat(parts[1]);
    const val2 = parseFloat(parts[2]);
    if (isNaN(val1) || isNaN(val2)) continue;

    // Türkiye UTM/ITRF: eğer ilk sayı Northing (≈ 4.2M–4.7M) ise format XYZ
    // eğer ilk sayı Easting (≈ 300K–800K veya 30M–39M) ise format YXZ
    const abs1 = Math.abs(val1);
    const abs2 = Math.abs(val2);

    // Northing ve Easting ayrımı:
    const isNorthing1 = abs1 > 1_000_000 && abs1 > abs2;
    const isNorthing2 = abs2 > 1_000_000 && abs2 > abs1;

    if (isNorthing1) return 'XYZ'; // 1. sütun Northing = X modu
    if (isNorthing2) return 'YXZ'; // 2. sütun Northing = Y modu (easting önce)
    break;
  }

  return 'YXZ'; // Türkiye standardı varsayılan
}

/**
 * NCN / TXT / CSV dosya içeriğini ayrıştırır.
 * Formatı otomatik tespit eder ve koordinatları doğru şekilde atar.
 */
export function parseNCN(content: string): ParseNCNResult {
  const lines = content.split('\n');
  const points: ImportedPoint[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  const format = detectNCNFormat(lines);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Boş satır ve yorum satırı atla
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed.startsWith('//')) continue;

    // Sayısal olmayan başlık satırlarını atla
    const parts = trimmed.split(/[\s,;|]+/);
    if (parts.length < 3) continue;

    // Ad her zaman ilk sütun
    const name = parts[0];

    let val1: number, val2: number, val3: number;

    if (parts.length >= 4) {
      val1 = parseFloat(parts[1]);
      val2 = parseFloat(parts[2]);
      val3 = parseFloat(parts[3]);
    } else if (parts.length === 3) {
      // İlk alan sayısal mı? — Sayısalsa ad yok (3 koordinat), değilse ad + 2 koordinat
      const firstIsNumeric = Number.isFinite(parseFloat(parts[0]));
      if (firstIsNumeric) {
        // Ad yok: 3 koordinat (X Y Z)
        val1 = parseFloat(parts[0]);
        val2 = parseFloat(parts[1]);
        val3 = parseFloat(parts[2]);
      } else {
        // Ad var, 2 koordinat: X Y formatı (Z=0 varsay)
        val1 = parseFloat(parts[1]);
        val2 = parseFloat(parts[2]);
        val3 = 0;
      }
    } else {
      continue;
    }

    if (isNaN(val1) || isNaN(val2) || isNaN(val3)) {
      // Baslik satirlarini sessiz gec, veri satiri gibi duran bozuk satirlari raporla.
      const lowerParts = parts.map(p => p.toLowerCase());
      const isHeader = i < 5 && ['name', 'nokta', 'point', 'x', 'y', 'z', 'north', 'east', 'kuzey', 'dogu']
        .some(token => lowerParts.includes(token));
      if (!isHeader) {
        skipped++;
        warnings.push(`Satır ${i + 1}: Geçersiz sayısal değer: "${trimmed}"`);
      }
      continue;
    }

    let northing: number, easting: number;

    // Format'a göre sütun ataması
    if (format === 'YXZ') {
      // Y(Easting) önce, X(Northing) sonra
      easting  = val1;
      northing = val2;
    } else if (format === 'XYZ') {
      // X(Northing) önce, Y(Easting) sonra
      northing = val1;
      easting  = val2;
    } else if (format === 'NEZ') {
      // Northing, Easting açık
      northing = val1;
      easting  = val2;
    } else {
      // Unknown: akıllı tahminci kullan
      const classified = classifyCoordinatePair(val1, val2);
      if (!classified) { skipped++; continue; }
      northing = classified.northing;
      easting  = classified.easting;
    }

    // Makul değer aralığı kontrolü (Türkiye)
    const latOk = Math.abs(northing) <= 90 || (northing > 3_000_000 && northing < 5_500_000);
    const lonOk = Math.abs(easting) <= 180  || (easting > 100_000 && easting < 45_000_000);
    if (!latOk || !lonOk) {
      skipped++;
      warnings.push(`Satır ${i + 1}: Koordinat aralık dışı (lat=${northing}, lon=${easting})`);
      continue;
    }

    points.push({
      name: name || `P${points.length + 1}`,
      lat: northing, // Northing → lat alanında saklanır
      lon: easting,  // Easting  → lon alanında saklanır
      alt: val3,
    });
  }

  if (skipped > 0) {
    warnings.push(`Toplam ${skipped} satır atlandı (geçersiz veri veya başlık).`);
  }

  return { points, format, warnings };
}
