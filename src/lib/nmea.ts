// ─────────────────────────────────────────────
// NMEA GGA Cümle Ayrıştırıcı
//
// GGA formatı (GPGGA / GNGGA):
//  $GPGGA,HHMMSS.ss,LLLL.LL,a,YYYYY.YY,a,q,nn,d.d,H.H,M,G.G,M,t.t,aaaa*hh
//  pos: 0=talker, 1=time, 2=lat, 3=NS, 4=lon, 5=EW,
//       6=fix, 7=sats, 8=hdop, 9=alt(MSL), 10=M, 11=geoid, 12=M, ...
// ─────────────────────────────────────────────

export interface NMEAData {
  lat: number;         // WGS84 enlem (derece)
  lon: number;         // WGS84 boylam (derece)
  alt: number;         // Elipsoidal yükseklik = MSL + geoidSep (metre)
  mslAlt: number;      // MSL (deniz seviyesi) yüksekliği
  geoidSep: number;    // Geoid ayrımı (N değeri)
  antennaAlt?: number; // Raw antenna ellipsoidal height before pole correction
  antennaMslAlt?: number; // Raw antenna MSL height before pole correction
  poleHeight?: number; // Antenna-to-pole-tip offset applied in meters
  fix: number;         // 0=geçersiz, 1=GPS, 2=DGPS, 4=RTK Fixed, 5=RTK Float
  satellites: number;  // Görünen uydu sayısı
  hdop: number;        // Yatay doğruluk faktörü (Horizontal DOP)
}

/**
 * GGA NMEA cümlesini ayrıştırır.
 *
 * Yükseklik notu:
 *   GGA parts[9]  = MSL (ortalama deniz seviyesi) yüksekliği
 *   GGA parts[11] = Geoid ayrımı (N) — WGS84 elipsoidi ile geoid arası fark
 *   Elipsoidal yükseklik (h) = MSL (H) + N
 *
 * RTK çalışmalarında ITRF/WGS84 elipsoidal yükseklik kullanılır.
 * İki nokta arasındaki kot farkı hesabında tutarlılık sağlamak için
 * her zaman elipsoidal yüksekliği kullanıyoruz.
 */
export function parseNMEA(sentence: string): NMEAData | null {
  if (!sentence.startsWith('$GNGGA') && !sentence.startsWith('$GPGGA')) {
    return null;
  }

  // Checksum doğrulaması (* sonrası hex)
  const starIdx = sentence.lastIndexOf('*');
  if (starIdx !== -1) {
    const checksumStr = sentence.substring(starIdx + 1).trim();
    const expected = parseInt(checksumStr, 16);
    let calc = 0;
    for (let i = 1; i < starIdx; i++) {
      calc ^= sentence.charCodeAt(i);
    }
    if (calc !== expected) {
      console.warn(`NMEA checksum hatası: hesaplanan=${calc.toString(16)} beklenen=${checksumStr}`);
      return null; // Bozuk cümle
    }
  }

  const parts = sentence.split(',');
  if (parts.length < 10) return null;

  const latStr  = parts[2];
  const latDir  = parts[3];
  const lonStr  = parts[4];
  const lonDir  = parts[5];
  const fixStr  = parts[6];
  const satStr  = parts[7];
  const hdopStr = parts[8];
  const altStr  = parts[9];  // MSL yükseklik
  // parts[10] = 'M' (birim)
  const geoidStr = parts[11] ?? '0'; // Geoid ayrımı

  if (!latStr || !lonStr || !altStr || latStr.length < 4 || lonStr.length < 5) return null;

  // DDMM.MMMM → DD.DDDDDD dönüşümü
  const latDeg = parseInt(latStr.substring(0, 2), 10);
  const latMin = parseFloat(latStr.substring(2));
  let lat = latDeg + latMin / 60;
  if (latDir === 'S') lat = -lat;

  const lonDeg = parseInt(lonStr.substring(0, 3), 10);
  const lonMin = parseFloat(lonStr.substring(3));
  let lon = lonDeg + lonMin / 60;
  if (lonDir === 'W') lon = -lon;

  const mslAlt   = parseFloat(altStr)  || 0;
  const geoidSep = parseFloat(geoidStr) || 0;
  const alt      = mslAlt + geoidSep; // Elipsoidal yükseklik

  const fix        = parseInt(fixStr, 10)  || 0;
  const satellites = parseInt(satStr, 10)  || 0;
  const hdop       = parseFloat(hdopStr)   || 99.9;

  // fix=0 → geçersiz konum
  if (fix === 0 || isNaN(lat) || isNaN(lon)) return null;

  return { lat, lon, alt, mslAlt, geoidSep, fix, satellites, hdop };
}

/**
 * RTK fix kalite etiketi
 */
export function getFixLabel(fix: number): { label: string; color: string } {
  switch (fix) {
    case 4:  return { label: 'RTK Fixed',  color: '#10b981' }; // emerald
    case 5:  return { label: 'RTK Float',  color: '#f59e0b' }; // amber
    case 2:  return { label: 'DGPS',       color: '#60a5fa' }; // blue
    case 1:  return { label: 'GPS',        color: '#94a3b8' }; // slate
    default: return { label: 'Fix Yok',   color: '#ef4444' }; // red
  }
}
