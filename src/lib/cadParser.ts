import { ImportedPoint } from './ncnParser';
// @ts-ignore
import DxfParser from 'dxf-parser';
import JSZip from 'jszip';

export const parseDXF = (fileContent: string): ImportedPoint[] => {
  const parser = new DxfParser();
  try {
    const dxf = parser.parseSync(fileContent);
    const points: ImportedPoint[] = [];

    if (dxf.entities) {
      dxf.entities.forEach((entity: any, index: number) => {
        // CAD sistemlerinde genellikle DXF noktaları POINT objesi olarak saklanır.
        // Bazen INSERT (Block reference) da olabilir ama temel aplikasyon için POINT kullanıyoruz.
        if (entity.type === 'POINT') {
          points.push({
            name: `P${index + 1}-DXF`,
            lon: entity.position.x, // CAD'de X ekseni genellikle Y veya Doğu (Lon) olur.
            lat: entity.position.y, // CAD'de Y ekseni genellikle X veya Kuzey (Lat) olur.
            alt: entity.position.z || 0
          });
        } else if (entity.type === 'TEXT') {
          // Bazen haritacılar noktaları TEXT objesi içine yazarlar. Text lokasyonu = Koordinat.
          points.push({
            name: entity.text || `T${index + 1}`,
            lon: entity.position.x,
            lat: entity.position.y,
            alt: entity.position.z || 0
          });
        }
      });
    }
    return points;
  } catch (error) {
    console.error("DXF Regex Parse Error:", error);
    throw new Error("DXF Okuma hatası");
  }
};

/**
 * .ncz (Netcad) ve .dwg (AutoCAD) İkili (Binary) Dosya Okuyucu (Deneysel)
 * Not: Bu formatlar şifrelenmiş ve kapalı kaynaklı oldukları için,
 * bu fonksiyon dosya içindeki düz metin tabanlı (ASCII) "X Y Z" sayı öbeklerini
 * Regex (Düzenli İfadeler) ile yakalamaya çalışır (Brute-Force extraction).
 */
export const parseBinaryCAD = async (file: File): Promise<ImportedPoint[]> => {
  const points: ImportedPoint[] = [];
  const uniqueKeys = new Set<string>();
  let pointCounter = 1;

  // Haritacı ITRF/ED50/WGS84 koordinat mantığı
  const coordinateRegex = /([\d]{5,7}\.\d{2,4})[\s,;|]+([\d]{5,7}\.\d{2,4})[\s,;|]+([\d]{1,4}\.\d{2,4})?/g;

  const extractPointsFromText = (text: string) => {
    let match;
    while ((match = coordinateRegex.exec(text)) !== null && points.length < 5000) {
      const val1 = parseFloat(match[1]);
      const val2 = parseFloat(match[2]);
      const val3 = match[3] ? parseFloat(match[3]) : 0;
      
      const key = `${val1.toFixed(1)}_${val2.toFixed(1)}`;
      if (!uniqueKeys.has(key)) {
        uniqueKeys.add(key);
        points.push({
          name: `BinP-${pointCounter}`,
          lon: val1,
          lat: val2,
          alt: val3
        });
        pointCounter++;
      }
    }
  };

  try {
    // NCZ dosyaları modern Netcad sürümlerinde (7/8) gizli bir ZIP dosyası olabilir.
    // Öncelikle ZIP olarak açmaya çalışıyoruz.
    const zip = new JSZip();
    const contents = await zip.loadAsync(file);
    
    // Klasör içindeki dosyaları tara ve metin olarak çöz
    const fileNames = Object.keys(contents.files);
    for (const fileName of fileNames) {
      if (!contents.files[fileName].dir) {
        const fileData = await contents.files[fileName].async('string');
        extractPointsFromText(fileData);
      }
    }
  } catch (zipError) {
    // ZIP değilse veya hata verirse, eski Netcad (Netcad 5 formatı gibi) düz binary'dir.
    // Geri çekilerek saf Binary okuyucusuna (Brute-Force) düşüyoruz.
    console.warn("ZIP açma denemesi başarısız, brute-force binary okuma yapılıyor...", zipError);
    const buffer = await file.arrayBuffer();
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    extractPointsFromText(text);
  }

  return points;
};
