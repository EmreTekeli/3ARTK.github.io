# SlopeFix RTK

SlopeFix RTK, GNSS/RTK verisiyle hedef nokta aplikasyonu, eğim düzlemi düzeltmesi, NCN/DXF içe aktarma ve çevrimdışı harita önbelleği için geliştirilmiş bir React + Vite uygulamasıdır.

## Gereksinimler

- Node.js 22 veya üzeri
- Chrome tabanlı tarayıcı
- USB/Bluetooth COM bağlantısı için Web Serial desteği
- Telefon GPS test modu için tarayıcı konum izni

## Kurulum

```bash
npm install
```

## Geliştirme

```bash
npm run dev
```

Varsayılan adres:

```text
http://localhost:3000
```

Farklı port için:

```powershell
$env:PORT="3100"; npm run dev
```

## Production

Önce statik istemci çıktısını üretin:

```bash
npm run build
```

Sonra production server başlatın:

```bash
npm start
```

## NTRIP Güvenlik Ayarları

Server, NTRIP hedeflerini varsayılan olarak özel/ağ içi IP adreslerine çözülüyorsa reddeder. Portlar varsayılan olarak `80,443,2101,2102,2103` ile sınırlıdır.

İsteğe bağlı ortam değişkenleri:

```text
NTRIP_ALLOWED_PORTS=2101,2102
NTRIP_ALLOWED_HOSTS=caster.example.com,212.156.70.42
ALLOWED_ORIGINS=https://example.com
```

## Doğrulama

```bash
npm run lint
npm test
npm run build
npm audit --omit=dev
```

## Notlar

- Web Serial ve Web Bluetooth çoğu tarayıcıda güvenli bağlam ister. Yerelde `localhost` desteklenir.
- Çevrimdışı harita önbelleği IndexedDB/localforage kullanır.
- DWG/NCZ ayrıştırma deneysel brute-force koordinat çıkarımıdır; güvenilir aktarım için DXF veya NCN önerilir.
