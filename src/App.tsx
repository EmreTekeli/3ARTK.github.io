import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  calculateDistance,
  calculateStakeoutMetrics,
  metricPointToGeo,
  projectPointToPlane,
  interpolateZOnPlane,
  createMetricContext,
  toMetricPoint,
  regionalPlaneZ,
  type GeoPoint3D,
  type SurfaceModel,
  type SurfaceFitReport,
} from './lib/geo';
import { parseNMEA, getFixLabel, NMEAData } from './lib/nmea';
import { parseNCN, ImportedPoint } from './lib/ncnParser';
import { ACCURACY_MODE_LABELS, evaluateRtkQuality, type AccuracyMode } from './lib/quality';
import { addAndroidGnssListeners, isNativeAndroidGnss, SlopeFixGnss, type AndroidBluetoothDevice } from './lib/androidGnss';
import { loadPersistedState, persist, type RtkConfigSnapshot } from './lib/persistence';
import { useSurfaceModel } from './hooks/useSurfaceModel';
import { useVoiceGuidance } from './hooks/useVoiceGuidance';
import {
  applyPoleHeightToPoint,
  getFixDerivedRtkStatus,
  normalizeCorrectionProfile,
  TUSAGA_CORRECTION_PROFILE,
  TUSAGA_MOUNTPOINTS,
  validateCorrectionProfile,
  type RtkStatus,
} from './lib/rtk';
import { 
  MapPin, ArrowUp, ArrowDown, CheckCircle, Activity, Settings2,
  Terminal, Download, Trash2, X, Upload, FileText, Usb, WifiOff,
  Bluetooth, Crosshair, Navigation, ChevronDown, Ruler, Volume2, VolumeX, Map as MapIcon,
  Target, Radio, Gauge, Plug
} from 'lucide-react';
import MapView from './components/MapView';

interface LogEntry {
  id: string;
  timestamp: string;
  type: 'INFO' | 'WARN' | 'NMEA' | 'CALC' | 'API' | 'ERROR';
  message: string;
  details?: string;
}

interface ImportSummary {
  fileName: string;
  pointCount: number;
  coordinateMode: 'WGS84' | 'PROJECTED' | 'MIXED';
  firstPoint?: ImportedPoint;
  warnings: string[];
}

const TUSAGA_PRESET = {
  ...TUSAGA_CORRECTION_PROFILE,
  port: String(TUSAGA_CORRECTION_PROFILE.port),
};

export default function App() {
  const nativeAndroidGnss = isNativeAndroidGnss();
  const [targetDistance, setTargetDistance] = useState<number>(1.50);
  const [referencePoint, setReferencePoint] = useState<NMEAData | null>(null);
  const [currentPoint, setCurrentPoint] = useState<NMEAData | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionType, setConnectionType] = useState<'NONE' | 'SERIAL' | 'BLE' | 'SIMULATOR' | 'ANDROID_BT'>('NONE');
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  // IMPROVE-4: Kullanıcı tarafından ayarlanabilir baud rate
  const [baudRate, setBaudRate] = useState<number>(38400);
  const [poleHeight, setPoleHeight] = useState<number>(() => {
    const stored = window.localStorage.getItem('slopefix:poleHeight');
    const parsed = stored ? Number(stored) : 2.0;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2.0;
  });
  const [accuracyMode, setAccuracyMode] = useState<AccuracyMode>('RTK_NORMAL');
  const [polePanelOpen, setPolePanelOpen] = useState(false);
  const [rtkSettingsOpen, setRtkSettingsOpen] = useState(false);
  const [targetMode, setTargetMode] = useState<'DISTANCE' | 'POINT'>('DISTANCE');
  type SectionKey = 'connection' | 'pole' | 'accuracy' | 'rtk' | 'p1' | 'target';
  const [activeSection, setActiveSection] = useState<SectionKey | null>(null);
  const [androidDevices, setAndroidDevices] = useState<AndroidBluetoothDevice[]>([]);
  const [selectedAndroidDevice, setSelectedAndroidDevice] = useState('');

  const portRef = useRef<any>(null);
  const readerRef = useRef<any>(null);
  const serialWriterRef = useRef<any>(null);
  const poleHeightRef = useRef<number>(2.0);
  const lastGgaSentenceRef = useRef<string>('');
  const ntripGgaTimerRef = useRef<number | null>(null);
  const rtcmWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [rtkConfig, setRtkConfig] = useState({
    host: '',
    port: '2101',
    mountPoint: '',
    username: '',
    password: '',
    useTls: false,
  });
  const rtkConfigRef = useRef(rtkConfig);
  const rtkShouldRunRef = useRef(false);
  const [rtkStatus, setRtkStatus] = useState<RtkStatus>('OFF');
  const rtkStatusRef = useRef<typeof rtkStatus>('OFF');
  const [rtkMessage, setRtkMessage] = useState('RTK duzeltmesi kapali.');
  const [rtkBytes, setRtkBytes] = useState(0);
  const [rtkBytesPerSecond, setRtkBytesPerSecond] = useState(0);
  const [rtkLastGgaAt, setRtkLastGgaAt] = useState<number | null>(null);
  const [rtkLastRtcmAt, setRtkLastRtcmAt] = useState<number | null>(null);
  const [rtkFixedSince, setRtkFixedSince] = useState<number | null>(null);
  const rtkBytesRef = useRef(0);
  const rtkBytesSampleRef = useRef({ bytes: 0, at: Date.now() });
  const rtkReconnectTimerRef = useRef<number | null>(null);
  const rtkReconnectAttemptRef = useRef(0);
  const scheduleRtkReconnectRef = useRef<(() => void) | null>(null);
  const bleDeviceRef = useRef<any>(null);
  const bleServerRef = useRef<any>(null);
  const bleTxCharRef = useRef<any>(null);
  const bleRxCharRef = useRef<any>(null);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  
  const [notification, setNotification] = useState<{message: string, type: 'success' | 'error' | 'info'} | null>(null);

  const showNotification = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 5000);
  };

  const [importedPoints, setImportedPoints] = useState<ImportedPoint[]>([]);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [surfaceAdjustedPoints, setSurfaceAdjustedPoints] = useState<ImportedPoint[]>([]);
  const [showSurfaceLayer, setShowSurfaceLayer] = useState<boolean>(true);
  const [surfaceModel, setSurfaceModel] = useState<SurfaceModel | null>(null);
  const gnssSamplesRef = useRef<GeoPoint3D[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Harita/listeden seçilen ham NCN noktası.
   * Z değeri dosyadan geldiği gibi (düz zemin). Eğim düzeltmesi uygulanmamış.
   */
  const [selectedNCNTarget, setSelectedNCNTarget] = useState<ImportedPoint | null>(null);

  /**
   * Eğim düzlemine göre Z'si yeniden hesaplanmış hedef koordinat.
   * Bu koordinat stakeout hesabında kullanılır.
   * Eğim düzlemi yoksa = selectedNCNTarget'ın orijinal koordinatı.
   */
  const [slopeCorrectedTarget, setSlopeCorrectedTarget] = useState<NMEAData | null>(null);

  const [metrics, setMetrics] = useState({
    plane2dDistance: 0,
    surface3dDistance: 0,
    horizontalDistance: 0,
    elevationDifference: 0,
    realDistance: 0,
    deltaNorth: 0,
    deltaEast: 0,
    surfaceCorrected: false,
    surfaceSource: 'none',
    surfaceConfidence: 0,
    slopeDeg: 0,
    slopeAzimuthDeg: 0,
    surfacePointsUsed: 0,
    residualRMS: 0,
    slopeZCorrection: 0,
    qualityOk: false,
    qualityReason: 'GNSS verisi yok',
    qualityMode: 'RTK_NORMAL' as AccuracyMode,
    maxSurfaceRms: 0.10,
    error: 0,
    direction: 'WAITING',
  });

  const [showPoleWarning, setShowPoleWarning] = useState(false);
  const prevPoleHeightRef = useRef<number>(poleHeight);
  const prevAccuracyModeRef = useRef<AccuracyMode>(accuracyMode);
  const ntripConnectTimerRef = useRef<number | null>(null);
  const [measurementLog, setMeasurementLog] = useState<Array<{
    timestamp: string; lat: number; lon: number; alt: number;
    fix: number; hdop: number; satellites: number;
    surfaceRms: number | null; distanceToTarget: number | null;
    targetName: string | null;
  }>>([]);

  const ws = useRef<WebSocket | null>(null);
  const wsReconnectTimerRef = useRef<number | null>(null);
  const wsReconnectAttemptRef = useRef(0);
  const targetDistanceRef = useRef(targetDistance);
  const referencePointRef = useRef<NMEAData | null>(referencePoint);

  useEffect(() => {
    rtkStatusRef.current = rtkStatus;
  }, [rtkStatus]);

  useEffect(() => {
    rtkBytesRef.current = rtkBytes;
  }, [rtkBytes]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const elapsed = (now - rtkBytesSampleRef.current.at) / 1000;
      if (elapsed <= 0) return;
      const delta = rtkBytesRef.current - rtkBytesSampleRef.current.bytes;
      setRtkBytesPerSecond(Math.max(0, delta / elapsed));
      rtkBytesSampleRef.current = { bytes: rtkBytesRef.current, at: now };
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (currentPoint?.fix === 4) {
      setRtkFixedSince(prev => prev ?? Date.now());
    } else {
      setRtkFixedSince(null);
    }
  }, [currentPoint?.fix]);

  useEffect(() => {
    rtkConfigRef.current = rtkConfig;
  }, [rtkConfig]);

  useEffect(() => {
    targetDistanceRef.current = targetDistance;
  }, [targetDistance]);

  useEffect(() => {
    referencePointRef.current = referencePoint;
  }, [referencePoint]);

  useEffect(() => {
    poleHeightRef.current = Number.isFinite(poleHeight) ? Math.max(0, poleHeight) : 0;
    window.localStorage.setItem('slopefix:poleHeight', String(poleHeightRef.current));
  }, [poleHeight]);

  const applyPoleHeightCorrection = useCallback((point: NMEAData): NMEAData => {
    return applyPoleHeightToPoint(point, poleHeightRef.current);
  }, []);

  // --- JALON YÜKSEKLİĞİ DEĞİŞİM UYARISI ---
  useEffect(() => {
    if (prevPoleHeightRef.current !== poleHeight && referencePoint && hydratedRef.current) {
      setShowPoleWarning(true);
    }
    prevPoleHeightRef.current = poleHeight;
  }, [poleHeight, referencePoint]);

  // --- KALİBRASYON SIFIRLAMA (TEST → RTK geçişi) ---
  useEffect(() => {
    if (prevAccuracyModeRef.current === 'TEST' && accuracyMode !== 'TEST') {
      if (calibScale !== 1.0) {
        setCalibScale(1.0);
        addLog('INFO', 'RTK moduna geçildi — kalibrasyon katsayısı sıfırlandı.');
      }
    }
    prevAccuracyModeRef.current = accuracyMode;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accuracyMode]);

  // --- CALIBRATION STATE ---
  const [showCalibration, setShowCalibration] = useState(false);
  const [calibKnownDistance, setCalibKnownDistance] = useState<number>(2.00);
  const [calibPtA, setCalibPtA] = useState<NMEAData | null>(null);
  const [calibPtB, setCalibPtB] = useState<NMEAData | null>(null);
  const [calibScale, setCalibScale] = useState<number>(1.0);

  // --- PERSISTENCE HYDRATION (mount-only) ---
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    let cancelled = false;
    (async () => {
      const defaults = {
        importedPoints: [] as ImportedPoint[],
        referencePoint: null as NMEAData | null,
        calibScale: 1.0,
        accuracyMode: 'RTK_NORMAL' as AccuracyMode,
        poleHeight: poleHeightRef.current,
        targetDistance: 1.5,
        rtkConfig: {
          host: '', port: '2101', mountPoint: '',
          username: '', password: '', useTls: false,
        } as RtkConfigSnapshot,
      };
      const loaded = await loadPersistedState(defaults);
      if (cancelled) return;
      hydratedRef.current = true;
      if (loaded.importedPoints?.length) setImportedPoints(loaded.importedPoints);
      if (loaded.referencePoint) setReferencePoint(loaded.referencePoint);
      if (Number.isFinite(loaded.calibScale)) setCalibScale(loaded.calibScale);
      if (loaded.accuracyMode) setAccuracyMode(loaded.accuracyMode);
      if (Number.isFinite(loaded.poleHeight)) setPoleHeight(loaded.poleHeight);
      if (Number.isFinite(loaded.targetDistance)) setTargetDistance(loaded.targetDistance);
      if (loaded.rtkConfig) setRtkConfig(loaded.rtkConfig);
    })();
    return () => { cancelled = true; };
  }, []);

  // --- PERSISTENCE SAVE (per key) ---
  useEffect(() => { if (hydratedRef.current) void persist.importedPoints(importedPoints); }, [importedPoints]);
  useEffect(() => { if (hydratedRef.current) void persist.referencePoint(referencePoint); }, [referencePoint]);
  useEffect(() => { if (hydratedRef.current) void persist.calibScale(calibScale); }, [calibScale]);
  useEffect(() => { if (hydratedRef.current) void persist.accuracyMode(accuracyMode); }, [accuracyMode]);
  useEffect(() => { if (hydratedRef.current) void persist.poleHeight(poleHeight); }, [poleHeight]);
  useEffect(() => { if (hydratedRef.current) void persist.targetDistance(targetDistance); }, [targetDistance]);
  useEffect(() => { if (hydratedRef.current) void persist.rtkConfig(rtkConfig); }, [rtkConfig]);

  // --- AUDIO SYNTHESIS STATE ---
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(false);

  const geoWatchIdRef = useRef<number | null>(null);
  const gpsSetupDoneRef = useRef<boolean>(false);

  // --- DISTANCE FORMATTER ---
  const formatDistanceDetail = (meters: number, addSignContext = false) => {
    const absM = Math.abs(meters);
    const sign = meters < 0 ? '-' : (addSignContext && meters > 0 ? '+' : '');

    if (absM >= 1000) {
      return { val: `${sign}${(absM / 1000).toFixed(3)}`, unit: 'km' };
    } else if (absM >= 1) {
      return { val: `${sign}${absM.toFixed(3)}`, unit: 'm' };
    } else if (absM > 0) {
      return { val: `${sign}${(absM * 1000).toFixed(0)}`, unit: 'mm' };
    } else {
      return { val: '0', unit: 'm' };
    }
  };

  // --- LOGGING ---
  const addLog = (type: LogEntry['type'], message: string, details?: any) => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      type,
      message,
      details: details ? JSON.stringify(details) : undefined
    }].slice(-500));
  };

  const handleExportLogs = () => {
    const logContent = logs.map(l => `[${l.timestamp}] [${l.type}] ${l.message} ${l.details || ''}`).join('\n');
    const blob = new Blob([logContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `slopefix_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog('INFO', 'Loglar başarıyla dışa aktarıldı.');
  };

  const handleExportCSV = () => {
    if (measurementLog.length === 0) {
      showNotification('Henüz kaydedilmiş ölçüm yok.', 'info');
      return;
    }
    const header = 'Zaman,Enlem,Boylam,Yukseklik(m),Fix,HDOP,Uydu,YuzeyRMS(m),Mesafe(m),Hedef';
    const rows = measurementLog.map(r =>
      [r.timestamp, r.lat.toFixed(8), r.lon.toFixed(8), r.alt.toFixed(4),
       r.fix, r.hdop.toFixed(2), r.satellites,
       r.surfaceRms?.toFixed(4) ?? '', r.distanceToTarget?.toFixed(4) ?? '',
       r.targetName ?? ''].join(',')
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `slopefix_olcumler_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog('INFO', `${measurementLog.length} ölçüm CSV olarak dışa aktarıldı.`);
  };

  const formatAge = (timestamp: number | null) => {
    if (!timestamp) return '-';
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    return `${seconds}s`;
  };

  const displayFixLabel = (fix: number, connType: typeof connectionType) => {
    if (connType === 'SIMULATOR') return { label: 'Telefon GPS (~5m)', color: '#94a3b8' };
    return getFixLabel(fix);
  };

  const buildImportSummary = (fileName: string, points: ImportedPoint[], parserWarnings: string[] = []): ImportSummary => {
    const projectedCount = points.filter(p => Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180).length;
    const wgsCount = points.length - projectedCount;
    const coordinateMode =
      projectedCount > 0 && wgsCount > 0 ? 'MIXED' :
      projectedCount > 0 ? 'PROJECTED' :
      'WGS84';
    const warnings = [...parserWarnings];
    const firstPoint = points[0];

    if (coordinateMode === 'MIXED') {
      warnings.push('Dosyada WGS84 ve projected koordinatlar karisik gorunuyor.');
    }

    if (firstPoint && coordinateMode === 'PROJECTED') {
      const possibleSwap = Math.abs(firstPoint.lon) > Math.abs(firstPoint.lat);
      if (possibleSwap) {
        warnings.push('Ilk noktada X/Y sirasi supheli: Easting degeri Northing degerinden buyuk.');
      }
      if (Math.abs(firstPoint.lon) < 100_000 || Math.abs(firstPoint.lat) < 1_000_000) {
        warnings.push('Projected koordinat araligi beklenenden dusuk; DOM veya lokal koordinat ayari gerekebilir.');
      }
    }

    return { fileName, pointCount: points.length, coordinateMode, firstPoint, warnings };
  };

  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, showLogs]);

  // --- FILE UPLOAD ---
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.split('.').pop()?.toLowerCase() || '';

    try {
      let points: ImportedPoint[] = [];
      let parserWarnings: string[] = [];

      if (ext === 'ncn' || ext === 'txt' || ext === 'csv') {
        const text = await file.text();
        const ncnResult = parseNCN(text);
        points = ncnResult.points;
        parserWarnings = ncnResult.warnings;
        // NCN uyarılarını logla
        if (ncnResult.warnings.length > 0) {
          ncnResult.warnings.forEach(w => addLog('INFO', `NCN Parser: ${w}`));
        }
        addLog('INFO', `NCN Format tespit edildi: ${ncnResult.format}`);
      } else if (ext === 'dxf') {
        const text = await file.text();
        const { parseDXF } = await import('./lib/cadParser');
        points = parseDXF(text);
      } else if (ext === 'dwg' || ext === 'ncz') {
        showNotification('DWG/NCZ formatı desteklenmiyor. Lütfen DXF veya NCN formatında kaydedin.', 'error');
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      } else {
        showNotification('Desteklenmeyen dosya formatı.', 'error');
        return;
      }

      if (points.length > 0) {
        const summary = buildImportSummary(file.name, points, parserWarnings);
        setImportedPoints(points);
        setImportSummary(summary);
        addLog('INFO', `${file.name} dosyasından ${points.length} nokta aktarıldı.`);
        if (summary.warnings.length > 0) {
          summary.warnings.forEach(w => addLog('INFO', `Import kontrol: ${w}`));
          showNotification(`${points.length} nokta yuklendi; koordinat uyarilarini kontrol edin.`, 'info');
        } else {
          showNotification(`${points.length} adet nokta başarıyla yüklendi.`, 'success');
        }
      } else {
        showNotification('Dosyada geçerli aplikasyon noktası bulunamadı.', 'error');
      }
    } catch (err: any) {
      addLog('ERROR', `Dosya okuma hatası: ${err.message}`);
      showNotification('Dosya okuma hatası veya eksik veri formatı.', 'error');
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleClearImportedPoints = () => {
    setImportedPoints([]);
    setImportSummary(null);
    setSurfaceAdjustedPoints([]);
    setSelectedNCNTarget(null);
    setSlopeCorrectedTarget(null);
    setTargetMode('DISTANCE');
    addLog('INFO', 'Yuklenen proje noktalari temizlendi.');
    showNotification('Yuklenen noktalar silindi. Yeni dosya yukleyebilirsiniz.', 'success');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /**
   * Haritadan veya listeden NCN noktası seçildiğinde:
   *  1. Ham NCN noktasını sakla (düz zemin koordinatı)
   *  2. Eğim düzlemi varsa hedef Z'sini düzlemden hesapla
   *  3. Eğim düzeltmeli koordinatı referans olarak ata
   * Eğim düzlemi henüz hesaplanmamışsa (< 3 nokta), Z olduğu gibi kullanılır.
   * Kullanıcı hareket ettikçe düzlem güncellenir ve hedef Z otomatik güncellenir.
   */
  const handleSelectPoint = useCallback((point: ImportedPoint) => {
    setSelectedNCNTarget(prev =>
      prev && prev.name === point.name &&
      Math.abs(prev.lat - point.lat) < 1e-10 &&
      Math.abs(prev.lon - point.lon) < 1e-10 &&
      Math.abs(prev.alt - point.alt) < 0.001
        ? prev
        : point
    );
    setSlopeCorrectedTarget(prev =>
      prev &&
      Math.abs(prev.lat - point.lat) < 1e-10 &&
      Math.abs(prev.lon - point.lon) < 1e-10 &&
      Math.abs(prev.alt - point.alt) < 0.001
        ? prev
        : { lat: point.lat, lon: point.lon, alt: point.alt }
    );
    setTargetMode('POINT');
    addLog('API', `NCN noktası seçildi: ${point.name} | Z(NCN)=${point.alt.toFixed(3)}m`, point);
  }, []);

  const pushGnssSample = useCallback((point: NMEAData) => {
    const sample: GeoPoint3D = { lat: point.lat, lon: point.lon, alt: point.alt };
    const prev = gnssSamplesRef.current[gnssSamplesRef.current.length - 1];

    if (prev) {
      try {
        const ctx = createMetricContext(prev, sample);
        const prevM = toMetricPoint(prev, ctx);
        const curM = toMetricPoint(sample, ctx);
        const dx = curM[0] - prevM[0];
        const dy = curM[1] - prevM[1];
        const dz = curM[2] - prevM[2];
        const horizontalJump = Math.sqrt(dx * dx + dy * dy);
        if (horizontalJump > 1.2 || Math.abs(dz) > 1.5) {
          addLog('INFO', 'GNSS ornegi atlandi (jump)', {
            horizontalJump: Number(horizontalJump.toFixed(3)),
            dz: Number(dz.toFixed(3)),
            from: prev,
            to: sample,
          });
          return;
        }
      } catch {
        return;
      }
    }

    gnssSamplesRef.current.push(sample);
    if (gnssSamplesRef.current.length > 20) {
      gnssSamplesRef.current.splice(0, gnssSamplesRef.current.length - 20);
    }
  }, []);

  useEffect(() => {
    if (!nativeAndroidGnss) return;

    let cleanup: (() => void) | null = null;
    let cancelled = false;

    addAndroidGnssListeners({
      onNmea: (line) => {
        if (line.startsWith('$GNGGA') || line.startsWith('$GPGGA')) {
          lastGgaSentenceRef.current = line;
          const parsed = parseNMEA(line);
          if (parsed) {
            const corrected = applyPoleHeightCorrection(parsed);
            setCurrentPoint(corrected);
            if (
              rtkShouldRunRef.current &&
              rtkStatusRef.current !== 'ERROR' &&
              rtkStatusRef.current !== 'DISCONNECTED' &&
              rtkStatusRef.current !== 'OFF'
            ) {
              const derived = getFixDerivedRtkStatus(corrected, rtkStatusRef.current);
              if (derived === 'FIXED' || derived === 'FLOAT') setRtkStatus(derived);
            }
          }
        }
      },
      onDeviceStatus: (status) => {
        if (status.status === 'CONNECTED') {
          setIsConnected(true);
          setConnectionType('ANDROID_BT');
          setIsSimulationMode(false);
          addLog('INFO', `Android Bluetooth SPP baglandi: ${status.deviceName || status.deviceAddress || 'cihaz'}`);
          showNotification('RTK cihazi Bluetooth SPP ile baglandi.', 'success');
        } else if (status.status === 'DISCONNECTED') {
          setIsConnected(false);
          setConnectionType('NONE');
          rtkShouldRunRef.current = false;
          if (ntripGgaTimerRef.current !== null) {
            window.clearInterval(ntripGgaTimerRef.current);
            ntripGgaTimerRef.current = null;
          }
          void SlopeFixGnss.stopNtrip().catch(() => {});
          setRtkStatus('OFF');
          addLog('INFO', 'Android Bluetooth SPP baglantisi kapandi.');
        } else if (status.status === 'ERROR') {
          setRtkStatus('ERROR');
          setRtkMessage(status.message || 'Bluetooth cihaz hatasi.');
          showNotification(status.message || 'Bluetooth cihaz hatasi.', 'error');
        }
      },
      onRtkStatus: (status) => {
        const nextStatus = (status.status || 'OFF') as RtkStatus;
        if (nextStatus === 'ERROR' || nextStatus === 'DISCONNECTED' || nextStatus === 'OFF') {
          rtkShouldRunRef.current = false;
        }
        setRtkStatus(nextStatus);
        setRtkMessage(status.message || nextStatus);
        if (nextStatus === 'ERROR') {
          showNotification(`RTK duzeltmesi durdu: ${status.message || 'NTRIP hatasi.'}`, 'error');
          addLog('ERROR', `Android NTRIP: ${status.message || status.code || 'hata'}`);
        } else if (nextStatus === 'DISCONNECTED') {
          showNotification('RTK duzeltmesi durdu: NTRIP baglantisi kapandi.', 'error');
          addLog('ERROR', `Android NTRIP: ${status.message || nextStatus}`);
        } else {
          addLog('INFO', `Android NTRIP: ${status.message || nextStatus}`);
        }
      },
      onRtcmWritten: (bytes, timestamp) => {
        setRtkBytes(prev => prev + bytes);
        setRtkLastRtcmAt(timestamp || Date.now());
      },
      onGgaSent: (sentAt) => {
        setRtkLastGgaAt(sentAt || Date.now());
      },
    }).then(listenerCleanup => {
      if (cancelled) listenerCleanup();
      else cleanup = listenerCleanup;
    }).catch((error) => {
      addLog('ERROR', 'Android GNSS dinleyicileri baslatilamadi.', error);
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [nativeAndroidGnss, applyPoleHeightCorrection]);

  useEffect(() => {
    if (!surfaceModel || importedPoints.length === 0) {
      setSurfaceAdjustedPoints([]);
      return;
    }

    const ctx = surfaceModel.context;
    const neighborsMetric: [number, number, number][] = [];
    for (const p of importedPoints) {
      try { neighborsMetric.push(toMetricPoint(p, ctx)); } catch { /* skip */ }
    }

    const adjusted = importedPoints.map((pt) => {
      try {
        const metric = toMetricPoint(pt, ctx);
        // Oncelik: bolgesel IDW (kendi lokal egimini yakalar). Yetersizse tek-duzlem projeksiyonuna dus.
        const regional = regionalPlaneZ(metric, neighborsMetric, 3, 8);
        let correctedMetric: [number, number, number];
        if (regional && Number.isFinite(regional.z)) {
          correctedMetric = [metric[0], metric[1], regional.z];
        } else {
          correctedMetric = projectPointToPlane(metric, surfaceModel.planePoint, surfaceModel.normal);
        }
        const geo = metricPointToGeo(correctedMetric, ctx, pt);
        return { ...pt, lat: geo.lat, lon: geo.lon, alt: geo.alt };
      } catch {
        return pt;
      }
    });

    setSurfaceAdjustedPoints(prev => {
      if (
        prev.length === adjusted.length &&
        prev.every((p, i) =>
          Math.abs(p.lat - adjusted[i].lat) < 1e-10 &&
          Math.abs(p.lon - adjusted[i].lon) < 1e-10 &&
          Math.abs(p.alt - adjusted[i].alt) < 1e-5
        )
      ) {
        return prev;
      }
      return adjusted;
    });
  }, [importedPoints, surfaceModel]);

  // --- WEBSOCKET CONNECTION ---
  useEffect(() => {
    let disposed = false;

    const clearReconnectTimer = () => {
      if (wsReconnectTimerRef.current !== null) {
        window.clearTimeout(wsReconnectTimerRef.current);
        wsReconnectTimerRef.current = null;
      }
    };

    const connect = () => {
      clearReconnectTimer();

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const socket = new WebSocket(wsUrl);

      ws.current = socket;

      socket.onopen = () => {
        if (disposed) {
          socket.close();
          return;
        }

        wsReconnectAttemptRef.current = 0;
        addLog('INFO', 'Sunucuya WebSocket ile bağlanıldı.');
        showNotification('Canlı sunucu bağlantısı sağlandı.', 'success');

        socket.send(JSON.stringify({ type: 'SET_TARGET', data: targetDistanceRef.current }));
        if (referencePointRef.current) {
          socket.send(JSON.stringify({ type: 'SET_REF', data: referencePointRef.current }));
        }
        if (rtkShouldRunRef.current && serialWriterRef.current) {
          const config = rtkConfigRef.current;
          if (!config.useTls) {
            addLog('WARN', 'NTRIP bağlantısı şifrelenmemiş (TLS kapalı). Kimlik bilgileri açık iletiliyor.');
          }
          socket.send(JSON.stringify({
            type: 'START_NTRIP',
            data: {
              host: config.host.trim(),
              port: Number(config.port || 2101),
              mountPoint: config.mountPoint.trim(),
              username: config.username,
              password: config.password,
              useTls: config.useTls,
            },
            gga: lastGgaSentenceRef.current,
          }));
          ntripConnectTimerRef.current = window.setTimeout(() => {
            if (rtkStatusRef.current === 'CONNECTING') {
              addLog('ERROR', 'NTRIP bağlantısı 10 saniyede yanıt vermedi.');
              stopRtkCorrection();
              showNotification('NTRIP zaman aşımı. Lütfen ayarları kontrol edin.', 'error');
            }
          }, 10_000);
        }
      };

      socket.onmessage = (event) => {
        if (disposed) return;

        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'CORRECTION') {
            // Sunucudan gelen gecikmeli mesafeyi devredışı bıraktık, yerel (0 lag) hesaplanıyor.
            if (Math.random() < 0.1) addLog('CALC', 'Sunucu hesaplaması (Arka Plan)', payload.data);
          } else if (payload.type === 'INFO') {
            addLog('INFO', payload.message);
          } else if (payload.type === 'ERROR') {
            addLog('ERROR', payload.message);
          } else if (payload.type === 'NTRIP_STATUS') {
            if (ntripConnectTimerRef.current !== null) {
              window.clearTimeout(ntripConnectTimerRef.current);
              ntripConnectTimerRef.current = null;
            }
            const ntripStatus = (payload.status || 'OFF') as RtkStatus;
            setRtkStatus(ntripStatus);
            setRtkMessage(payload.message || '');
            addLog('INFO', `NTRIP: ${payload.message || payload.status}`);
            if (ntripStatus === 'CONNECTED' || ntripStatus === 'FLOAT' || ntripStatus === 'FIXED') {
              rtkReconnectAttemptRef.current = 0;
              if (rtkReconnectTimerRef.current !== null) {
                window.clearTimeout(rtkReconnectTimerRef.current);
                rtkReconnectTimerRef.current = null;
              }
            } else if (ntripStatus === 'DISCONNECTED') {
              scheduleRtkReconnectRef.current?.();
            }
          } else if (payload.type === 'NTRIP_ERROR') {
            setRtkStatus('ERROR');
            setRtkMessage(payload.message || 'NTRIP hatasi.');
            addLog('ERROR', `NTRIP: ${payload.message || 'Bilinmeyen hata'}`);
            scheduleRtkReconnectRef.current?.();
          } else if (payload.type === 'RTCM') {
            const writer = serialWriterRef.current;
            if (!writer) {
              setRtkStatus('ERROR');
              setRtkMessage('RTCM geldi ancak seri port yazari hazir degil.');
              addLog('ERROR', 'RTCM yazilamadi: seri port yazari yok.');
              return;
            }

            const binary = atob(payload.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            rtcmWriteQueueRef.current = rtcmWriteQueueRef.current
              .then(async () => {
                await writer.write(bytes);
                setRtkBytes(prev => prev + (payload.bytes || bytes.length));
                setRtkLastRtcmAt(Date.now());
              })
              .catch((error: any) => {
                setRtkStatus('ERROR');
                setRtkMessage(`RTCM cihaza yazilamadi: ${error?.message || 'bilinmeyen hata'}`);
                addLog('ERROR', 'RTCM yazma hatasi', error);
              });
          }
        } catch (err) {
          console.error('WS Parse Hatası:', err);
        }
      };

      socket.onclose = () => {
        if (ws.current === socket) ws.current = null;
        if (disposed) return;

        if (rtkStatusRef.current === 'CONNECTING' || rtkStatusRef.current === 'CONNECTED' || rtkStatusRef.current === 'FLOAT' || rtkStatusRef.current === 'FIXED') {
          setRtkStatus('DISCONNECTED');
          setRtkMessage('Sunucu bağlantısı koptu. RTK oturumu yeniden başlatılmalı.');
        }

        wsReconnectAttemptRef.current += 1;
        const delay = Math.min(1000 * 2 ** (wsReconnectAttemptRef.current - 1), 10000);
        addLog('ERROR', `Sunucu bağlantısı koptu. ${Math.round(delay / 1000)} sn sonra yeniden denenecek.`);
        showNotification('Sunucu bağlantısı koptu. Yeniden bağlanılıyor...', 'error');
        wsReconnectTimerRef.current = window.setTimeout(connect, delay);
      };

      socket.onerror = () => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      clearReconnectTimer();

      const socket = ws.current;
      if (socket) {
        ws.current = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        if (socket.readyState === WebSocket.OPEN) {
          socket.close();
        } else if (socket.readyState === WebSocket.CONNECTING) {
          socket.onopen = () => socket.close();
        }
      }
    };
  }, []); // Run once on mount

  // --- TARGET SYNC ---
  useEffect(() => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'SET_TARGET', data: targetDistance }));
    }
  }, [targetDistance]);

  // --- REF POINT SYNC ---
  useEffect(() => {
    if (referencePoint && ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'SET_REF', data: referencePoint }));
    }
  }, [referencePoint]);

  // --- VOICE GUIDANCE (hook) ---
  const { speak: speakGuidance, lastDirectionRef: voiceLastDirectionRef } = useVoiceGuidance({
    enabled: isVoiceEnabled,
    targetDistance: targetMode === 'POINT' ? 0 : targetDistance,
  });

  // --- GPS HESAPLAMA ALTYAPISI ---
  const prevDistanceRef = useRef<number | null>(null);
  const lastSurfaceComputeRef = useRef<number>(0);
  const rafHandleRef = useRef<number | null>(null);
  const pendingGPSRef = useRef<NMEAData | null>(null);
  const prevGPSPointRef = useRef<NMEAData | null>(null);
  const estimatedSpeedRef = useRef<number>(0);
  const filteredGuidanceDistanceRef = useRef<number | null>(null);

  const {
    compute: computeSurface,
    invalidate: invalidateSurface,
    updateSpeed: updateSurfaceSpeed,
    getReport: getSurfaceReport,
  } = useSurfaceModel({ importedPoints, gnssSamplesRef });

  const [surfaceReport, setSurfaceReport] = useState<SurfaceFitReport>({ winner: null, candidates: [] });
  const [showSurfaceRationale, setShowSurfaceRationale] = useState<boolean>(false);

  useEffect(() => {
    invalidateSurface();
  }, [referencePoint?.lat, referencePoint?.lon, invalidateSurface]);

  const processGPS = useCallback((current: NMEAData) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'CUR_POS', data: current }));
    }
    const selectedPointTarget = selectedNCNTarget
      ? { lat: selectedNCNTarget.lat, lon: selectedNCNTarget.lon, alt: selectedNCNTarget.alt }
      : null;
    const activeTarget = targetMode === 'POINT' ? selectedPointTarget : referencePoint;
    if (!activeTarget) return;

    const now = Date.now();
    const elapsed = (now - lastSurfaceComputeRef.current) / 1000;
    if (prevGPSPointRef.current && elapsed > 0.1) {
      const prev = prevGPSPointRef.current;
      const dx = (current.lon - prev.lon) * 111320 * Math.cos(current.lat * Math.PI / 180);
      const dy = (current.lat - prev.lat) * 111320;
      estimatedSpeedRef.current = 0.7 * estimatedSpeedRef.current + 0.3 * (Math.sqrt(dx*dx+dy*dy) / elapsed);
    }
    prevGPSPointRef.current = current;
    updateSurfaceSpeed(estimatedSpeedRef.current);
    lastSurfaceComputeRef.current = now;

    const surface = computeSurface(activeTarget, current);
    setSurfaceModel(prev => (prev === surface ? prev : surface));
    const report = getSurfaceReport();
    setSurfaceReport(prev => (prev.winner === report.winner && prev.candidates.length === report.candidates.length ? prev : report));

    let effectiveTarget = activeTarget;
    let slopeZCorrection = 0;
    if (targetMode === 'POINT' && selectedNCNTarget && surface) {
      try {
        const baseTarget = { lat: selectedNCNTarget.lat, lon: selectedNCNTarget.lon, alt: selectedNCNTarget.alt };
        const targetMetric = toMetricPoint(baseTarget, surface.context);
        const planeFit = { normal: surface.normal, planePoint: surface.planePoint, slopeDeg: surface.slopeDeg, residualRMS: surface.residualRMS, pointsUsed: surface.pointsUsed };
        const correctedZ = interpolateZOnPlane(targetMetric[0], targetMetric[1], planeFit);
        const correctedMetric: [number, number, number] = [targetMetric[0], targetMetric[1], correctedZ ?? targetMetric[2]];
        const corrected = metricPointToGeo(correctedMetric, surface.context, baseTarget);
        slopeZCorrection = corrected.alt - selectedNCNTarget.alt;
        effectiveTarget = corrected;
        setSlopeCorrectedTarget(prev =>
          prev &&
          Math.abs(prev.lat - corrected.lat) < 1e-10 &&
          Math.abs(prev.lon - corrected.lon) < 1e-10 &&
          Math.abs(prev.alt - corrected.alt) < 0.001
            ? prev
            : corrected
        );
      } catch { /* dönüşüm başarısız */ }
    } else if (targetMode === 'POINT' && selectedPointTarget) {
      setSlopeCorrectedTarget(prev =>
        prev &&
        Math.abs(prev.lat - selectedPointTarget.lat) < 1e-10 &&
        Math.abs(prev.lon - selectedPointTarget.lon) < 1e-10 &&
        Math.abs(prev.alt - selectedPointTarget.alt) < 0.001
          ? prev
          : selectedPointTarget
      );
    }

    const baseMetrics = calculateStakeoutMetrics(effectiveTarget, current, surface);
    const s = calibScale;
    const scaledPlane2D    = baseMetrics.plane2dDistance    * s;
    const scaledSurface3D  = baseMetrics.surface3dDistance  * s;
    const scaledHorizontal = baseMetrics.horizontalDistance * s;
    const scaledReal       = baseMetrics.realDistance       * s;
    const scaledNorth      = baseMetrics.deltaNorth         * s;
    const scaledEast       = baseMetrics.deltaEast          * s;
    const scaledElev       = baseMetrics.elevationDifference * s;

    const pointStakeoutMode = targetMode === 'POINT';
    const rawGuidanceDist = pointStakeoutMode ? scaledPlane2D : scaledSurface3D;
    let guidanceDist = rawGuidanceDist;
    const isCloseRange = pointStakeoutMode ? rawGuidanceDist < 1 : Math.abs(rawGuidanceDist - targetDistance) < 1;
    if (isCloseRange) {
      const prevFiltered = filteredGuidanceDistanceRef.current;
      guidanceDist = prevFiltered === null ? rawGuidanceDist : prevFiltered * 0.65 + rawGuidanceDist * 0.35;
      filteredGuidanceDistanceRef.current = guidanceDist;
    } else {
      filteredGuidanceDistanceRef.current = null;
    }

    const error = pointStakeoutMode ? guidanceDist : guidanceDist - targetDistance;
    const quality = evaluateRtkQuality(current, accuracyMode, baseMetrics.residualRMS, baseMetrics.surfaceActive);
    let direction = 'WAITING';

    if (!quality.ok) {
      direction = 'QUALITY_WAIT';
    } else if (pointStakeoutMode) {
      if (guidanceDist <= 0.02) {
        direction = 'OK';
      } else if (prevDistanceRef.current !== null) {
        const delta = guidanceDist - prevDistanceRef.current;
        direction = delta < -0.01 ? 'APPROACHING' : delta > 0.01 ? 'RECEDING'
          : (voiceLastDirectionRef.current !== 'WAITING' ? voiceLastDirectionRef.current : 'APPROACHING');
      } else {
        direction = 'APPROACHING';
      }
    } else {
      if (Math.abs(error) <= 0.02) direction = 'OK';
      else direction = error > 0 ? 'BACK' : 'FORWARD';
    }

    prevDistanceRef.current = guidanceDist;

    const newMetrics = {
      ...baseMetrics,
      plane2dDistance: scaledPlane2D, surface3dDistance: scaledSurface3D,
      horizontalDistance: scaledHorizontal, realDistance: scaledReal,
      deltaNorth: scaledNorth, deltaEast: scaledEast,
      elevationDifference: scaledElev,
      surfaceCorrected: baseMetrics.surfaceActive,
      surfaceSource: baseMetrics.surfaceSource,
      surfaceConfidence: baseMetrics.confidence,
      slopeDeg: baseMetrics.slopeDeg,
      slopeAzimuthDeg: surface?.slopeAzimuthDeg ?? 0,
      surfacePointsUsed: surface?.pointsUsed ?? 0,
      residualRMS: baseMetrics.residualRMS,
      qualityOk: quality.ok,
      qualityReason: quality.reason,
      qualityMode: accuracyMode,
      maxSurfaceRms: quality.maxSurfaceRms,
      slopeZCorrection, error, direction,
    };

    setMetrics(newMetrics);

    // Ölçüm kaydı (son 1000 örnek)
    setMeasurementLog(prev => [...prev.slice(-999), {
      timestamp: new Date().toISOString(),
      lat: current.lat, lon: current.lon, alt: current.alt,
      fix: current.fix, hdop: current.hdop, satellites: current.satellites,
      surfaceRms: baseMetrics.residualRMS > 0 ? baseMetrics.residualRMS : null,
      distanceToTarget: scaledPlane2D,
      targetName: (targetMode === 'POINT' && selectedNCNTarget) ? selectedNCNTarget.name : null,
    }]);

    speakGuidance({
      direction: newMetrics.direction,
      qualityOk: newMetrics.qualityOk,
      qualityReason: newMetrics.qualityReason,
      error: newMetrics.error,
      deltaNorth: newMetrics.deltaNorth,
      deltaEast: newMetrics.deltaEast,
    });
  }, [referencePoint, selectedNCNTarget, targetMode, targetDistance, calibScale, accuracyMode, speakGuidance, computeSurface, updateSurfaceSpeed, getSurfaceReport]);

  useEffect(() => {
    if (!currentPoint) return;
    pushGnssSample(currentPoint);
    pendingGPSRef.current = currentPoint;
    if (rafHandleRef.current !== null) return;
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = null;
      const pt = pendingGPSRef.current;
      if (pt) processGPS(pt);
    });
    return () => {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = null;
      }
    };
  }, [currentPoint, processGPS, pushGnssSample]);

  const handleSetReference = () => {
    if (currentPoint) {
      const quality = evaluateRtkQuality(currentPoint, accuracyMode);
      if (!quality.ok && accuracyMode !== 'TEST') {
        showNotification(`Referans icin konum kalitesi yetersiz: ${quality.reason}`, 'error');
        addLog('ERROR', 'Referans kalite kapisi gecilemedi.', { mode: accuracyMode, quality, currentPoint });
        return;
      }
      setReferencePoint(currentPoint);
      addLog('API', 'Mevcut konum referans (P1) olarak ayarlandı', currentPoint);
    }
  };

  const captureCalibrationPoint = (slot: 'A' | 'B') => {
    if (!currentPoint) {
      showNotification('GNSS verisi yok!', 'error');
      return;
    }

    const quality = evaluateRtkQuality(currentPoint, accuracyMode);
    if (!quality.ok) {
      showNotification(`Kalibrasyon noktasi icin kalite yetersiz: ${quality.reason}`, 'error');
      addLog('ERROR', 'Kalibrasyon noktasi kalite kapisi gecilemedi.', { slot, mode: accuracyMode, quality, currentPoint });
      return;
    }

    if (slot === 'A') setCalibPtA(currentPoint);
    else setCalibPtB(currentPoint);
  };

  // --- CALIBRATION LOGIC ---
  const handleApplyCalibration = () => {
    if (calibPtA && calibPtB && calibKnownDistance > 0) {
      const qualityA = evaluateRtkQuality(calibPtA, accuracyMode);
      const qualityB = evaluateRtkQuality(calibPtB, accuracyMode);
      if (!qualityA.ok || !qualityB.ok) {
        addLog('ERROR', 'Kalibrasyon kalite kapisi gecilemedi.', { mode: accuracyMode, qualityA, qualityB });
        showNotification(`Kalibrasyon icin konum kalitesi yetersiz: ${!qualityA.ok ? qualityA.reason : qualityB.reason}`, 'error');
        return;
      }

      const { realDistance } = calculateDistance(
        calibPtA.lat, calibPtA.lon, calibPtA.alt,
        calibPtB.lat, calibPtB.lon, calibPtB.alt
      );

      if (!Number.isFinite(realDistance) || realDistance < 0.05) {
        addLog('ERROR', 'Kalibrasyon mesafesi gecersiz veya cok kisa.', { measured: realDistance });
        showNotification('Kalibrasyon icin iki farkli nokta arasinda en az 5 cm olcmelisiniz.', 'error');
        return;
      }

      const newScale = calibKnownDistance / realDistance;
      if (!Number.isFinite(newScale) || newScale <= 0 || newScale > 100) {
        addLog('ERROR', 'Kalibrasyon carpani gecersiz.', { measured: realDistance, known: calibKnownDistance, scale: newScale });
        showNotification('Kalibrasyon carpani gecersiz. Noktalari tekrar okuyun.', 'error');
        return;
      }

      setCalibScale(newScale);

      if (ws.current?.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ type: 'SET_SCALE', data: newScale }));
      }

      addLog('INFO', `GNSS Kalibre edildi. Carpan: ${newScale.toFixed(4)}`, { measured: realDistance, known: calibKnownDistance });
      showNotification('Kalibrasyon basarili! Hassasiyet guncellendi.', 'success');
      setShowCalibration(false);
    }
  };

  // --- RTK / NTRIP CORRECTION ---
  const sendGgaToNtrip = () => {
    if (nativeAndroidGnss && lastGgaSentenceRef.current) {
      void SlopeFixGnss.sendGga({ gga: lastGgaSentenceRef.current });
      setRtkLastGgaAt(Date.now());
      return;
    }
    if (ws.current?.readyState === WebSocket.OPEN && lastGgaSentenceRef.current) {
      ws.current.send(JSON.stringify({ type: 'NTRIP_GGA', data: lastGgaSentenceRef.current }));
      setRtkLastGgaAt(Date.now());
    }
  };

  const stopRtkCorrection = () => {
    rtkShouldRunRef.current = false;
    rtkReconnectAttemptRef.current = 0;
    if (rtkReconnectTimerRef.current !== null) {
      window.clearTimeout(rtkReconnectTimerRef.current);
      rtkReconnectTimerRef.current = null;
    }
    if (ntripGgaTimerRef.current !== null) {
      window.clearInterval(ntripGgaTimerRef.current);
      ntripGgaTimerRef.current = null;
    }
    if (ntripConnectTimerRef.current !== null) {
      window.clearTimeout(ntripConnectTimerRef.current);
      ntripConnectTimerRef.current = null;
    }

    if (nativeAndroidGnss) {
      void SlopeFixGnss.stopNtrip().catch(() => {});
    } else if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'STOP_NTRIP' }));
    }

    setRtkStatus('OFF');
    setRtkMessage('RTK duzeltmesi kapali.');
    setRtkBytesPerSecond(0);
    setRtkLastRtcmAt(null);
  };

  const startRtkCorrection = async () => {
    if (nativeAndroidGnss) {
      if (connectionType !== 'ANDROID_BT') {
        showNotification('RTK duzeltmesi icin once Android Bluetooth SPP ile GNSS cihazina baglanin.', 'error');
        return;
      }
    } else if (connectionType !== 'SERIAL' || !serialWriterRef.current) {
      showNotification('RTK duzeltmesi icin once USB/Bluetooth COM ile GNSS cihazina baglanin.', 'error');
      return;
    }

    if (!nativeAndroidGnss && (!ws.current || ws.current.readyState !== WebSocket.OPEN)) {
      showNotification('Sunucu WebSocket baglantisi hazir degil.', 'error');
      return;
    }

    const profile = normalizeCorrectionProfile({
      name: rtkConfig.host.trim() === TUSAGA_PRESET.host ? TUSAGA_PRESET.name : 'Ozel NTRIP',
      host: rtkConfig.host,
      port: Number(rtkConfig.port || 2101),
      mountPoint: rtkConfig.mountPoint,
      username: rtkConfig.username,
      password: rtkConfig.password,
      useTls: rtkConfig.useTls,
    });
    const validationError = validateCorrectionProfile(profile);

    if (validationError) {
      showNotification(validationError, 'error');
      return;
    }

    if (!lastGgaSentenceRef.current) {
      showNotification('Cihazdan gecerli GGA konum verisi bekleniyor.', 'error');
      setRtkStatus('OFF');
      setRtkMessage('NTRIP icin once gecerli GGA konum verisi gerekli.');
      return;
    }

    setRtkStatus('CONNECTING');
    rtkShouldRunRef.current = true;
    rtkReconnectAttemptRef.current = 0;
    setRtkBytes(0);
    rtkBytesSampleRef.current = { bytes: 0, at: Date.now() };
    setRtkBytesPerSecond(0);
    setRtkLastGgaAt(lastGgaSentenceRef.current ? Date.now() : null);
    setRtkLastRtcmAt(null);
    setRtkMessage('NTRIP baglantisi baslatiliyor...');

    if (nativeAndroidGnss) {
      try {
        await SlopeFixGnss.startNtrip({ ...profile, gga: lastGgaSentenceRef.current });
      } catch (error: any) {
        rtkShouldRunRef.current = false;
        setRtkStatus('ERROR');
        setRtkMessage(error?.message || 'Android NTRIP baslatilamadi.');
        showNotification(error?.message || 'Android NTRIP baslatilamadi.', 'error');
        addLog('ERROR', 'Android NTRIP baslatma hatasi', error);
      }
      return;
    }

    if (!profile.useTls) {
      addLog('WARN', 'NTRIP bağlantısı şifrelenmemiş (TLS kapalı). Kimlik bilgileri açık iletiliyor.');
    }
    ws.current?.send(JSON.stringify({
      type: 'START_NTRIP',
      data: {
        host: profile.host,
        port: profile.port,
        mountPoint: profile.mountPoint,
        username: profile.username,
        password: profile.password,
        useTls: profile.useTls,
      },
      gga: lastGgaSentenceRef.current,
    }));

    if (ntripGgaTimerRef.current !== null) {
      window.clearInterval(ntripGgaTimerRef.current);
    }
    ntripGgaTimerRef.current = window.setInterval(sendGgaToNtrip, profile.sendGgaIntervalMs);
  };

  const scheduleRtkReconnect = useCallback(() => {
    if (!rtkShouldRunRef.current) return;
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
    if (rtkReconnectTimerRef.current !== null) {
      window.clearTimeout(rtkReconnectTimerRef.current);
    }
    const MAX_ATTEMPTS = 5;
    if (rtkReconnectAttemptRef.current >= MAX_ATTEMPTS) {
      setRtkStatus('ERROR');
      setRtkMessage('Otomatik yeniden bağlantı başarısız. Lütfen manuel başlatın.');
      showNotification('NTRIP otomatik yeniden bağlantı başarısız.', 'error');
      return;
    }
    const delay = Math.min(5000 * Math.pow(2, rtkReconnectAttemptRef.current), 30_000);
    rtkReconnectAttemptRef.current += 1;
    setRtkMessage(`NTRIP yeniden bağlanılıyor... (${Math.round(delay / 1000)}s, deneme ${rtkReconnectAttemptRef.current}/${MAX_ATTEMPTS})`);
    addLog('INFO', `NTRIP yeniden bağlantı ${Math.round(delay / 1000)}s sonra (deneme ${rtkReconnectAttemptRef.current}/${MAX_ATTEMPTS}).`);
    rtkReconnectTimerRef.current = window.setTimeout(() => {
      rtkReconnectTimerRef.current = null;
      if (!rtkShouldRunRef.current) return;
      if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
      const config = rtkConfigRef.current;
      setRtkStatus('CONNECTING');
      ws.current.send(JSON.stringify({
        type: 'START_NTRIP',
        data: {
          host: config.host.trim(),
          port: Number(config.port || 2101),
          mountPoint: config.mountPoint.trim(),
          username: config.username,
          password: config.password,
          useTls: config.useTls,
        },
        gga: lastGgaSentenceRef.current,
      }));
      if (ntripConnectTimerRef.current !== null) window.clearTimeout(ntripConnectTimerRef.current);
      ntripConnectTimerRef.current = window.setTimeout(() => {
        if (rtkStatusRef.current === 'CONNECTING') scheduleRtkReconnectRef.current?.();
      }, 10_000);
    }, delay);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { scheduleRtkReconnectRef.current = scheduleRtkReconnect; }, [scheduleRtkReconnect]);

  // --- RTCM / GGA HEARTBEAT ---
  useEffect(() => {
    if (rtkStatus === 'OFF' || rtkStatus === 'DISCONNECTED') return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      const rtcmAge = rtkLastRtcmAt ? now - rtkLastRtcmAt : null;
      const ggaAge = rtkLastGgaAt ? now - rtkLastGgaAt : null;
      if (rtcmAge !== null && rtcmAge > 30_000) {
        if (rtkShouldRunRef.current && ws.current?.readyState === WebSocket.OPEN) {
          addLog('WARN', 'RTCM 30s gelmedi. NTRIP oturumu yenileniyor.');
          ws.current.send(JSON.stringify({ type: 'STOP_NTRIP' }));
          setRtkStatus('DISCONNECTED');
          setRtkMessage('RTCM zaman aşımı — yeniden bağlanılıyor...');
          setRtkLastRtcmAt(null);
          scheduleRtkReconnectRef.current?.();
        } else {
          addLog('WARN', 'RTCM verisi 30 saniyedir gelmiyor. RTK bağlantısı kesiliyor.');
          stopRtkCorrection();
        }
      } else if (rtcmAge !== null && rtcmAge > 5_000) {
        setRtkMessage(`RTCM verisi ${Math.floor(rtcmAge / 1000)}s gecikmiş — bağlantı zayıf.`);
      }
      if (ggaAge !== null && ggaAge > 15_000) {
        addLog('WARN', 'Cihazdan 15s GGA alınamadı. Konum sinyali yok.');
      }
    }, 2000);
    return () => window.clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rtkStatus, rtkLastRtcmAt, rtkLastGgaAt]);

  const applyTusagaPreset = () => {
    setRtkConfig(prev => ({
      ...prev,
      ...TUSAGA_PRESET,
      username: prev.username,
      password: prev.password,
      mountPoint: prev.mountPoint || TUSAGA_PRESET.mountPoint,
    }));
    showNotification('TUSAGA host ve port ayarlari dolduruldu. Kullanici/sifre ve mountpoint kontrol edin.', 'info');
  };

  // --- CONNECTIONS ---
  const disconnectDevice = async () => {
    stopRtkCorrection();
    if (nativeAndroidGnss && connectionType === 'ANDROID_BT') {
      await SlopeFixGnss.disconnectDevice().catch(() => {});
    }
    if (readerRef.current) await readerRef.current.cancel().catch(() => {});
    if (bleServerRef.current?.connected) {
      try { bleServerRef.current.disconnect(); } catch {}
    }
    bleDeviceRef.current = null;
    bleServerRef.current = null;
    bleTxCharRef.current = null;
    bleRxCharRef.current = null;
    if (serialWriterRef.current) {
      try {
        serialWriterRef.current.releaseLock();
      } catch {}
      serialWriterRef.current = null;
    }
    if (portRef.current) await portRef.current.close().catch(() => {});
    if (geoWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(geoWatchIdRef.current);
      geoWatchIdRef.current = null;
    }
    gpsSetupDoneRef.current = false;
    setIsConnected(false);
    setIsSimulationMode(false);
    setConnectionType('NONE');
    setRtkBytes(0);
    setReferencePoint(null); // Clear reference point so step 2 resets
    addLog('INFO', 'Cihaz bağlantısı kesildi');
  };

  const refreshAndroidBluetoothDevices = async () => {
    try {
      const result = await SlopeFixGnss.listBluetoothDevices();
      setAndroidDevices(result.devices || []);
      if (!selectedAndroidDevice && result.devices?.length === 1) {
        setSelectedAndroidDevice(result.devices[0].address);
      }
      if (!result.devices?.length) {
        showNotification('Eslesmis Bluetooth SPP cihazi bulunamadi. Once Android Bluetooth ayarlarindan RTK cihazini eslestirin.', 'info');
      }
    } catch (error: any) {
      addLog('ERROR', 'Bluetooth cihaz listesi alinamadi.', error);
      showNotification(error?.message || 'Bluetooth cihaz listesi alinamadi.', 'error');
    }
  };

  const handleConnectAndroidBluetooth = async () => {
    try {
      let address = selectedAndroidDevice;
      if (!address) {
        const result = await SlopeFixGnss.listBluetoothDevices();
        setAndroidDevices(result.devices || []);
        if (result.devices?.length === 1) {
          address = result.devices[0].address;
          setSelectedAndroidDevice(address);
        } else {
          showNotification('Baglanmak icin eslesmis RTK cihazini secin.', 'info');
          return;
        }
      }

      setConnectionType('ANDROID_BT');
      await SlopeFixGnss.connectBluetooth({ address });
    } catch (error: any) {
      setIsConnected(false);
      setConnectionType('NONE');
      addLog('ERROR', 'Android Bluetooth SPP baglanti hatasi', error);
      showNotification(error?.message || 'Android Bluetooth SPP baglantisi basarisiz.', 'error');
    }
  };

  const handleConnectSerial = async () => {
    if (nativeAndroidGnss) {
      await handleConnectAndroidBluetooth();
      return;
    }

    if (!('serial' in navigator)) {
      addLog('ERROR', 'Web Serial API desteklenmiyor.');
      showNotification('Tarayıcınız Seri Port bağlantısını desteklemiyor. Lütfen Chrome kullanın ve uygulamayı yeni sekmede açın.', 'error');
      return;
    }

    try {
      if (isConnected) await disconnectDevice();

      // @ts-ignore
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate }); // IMPROVE-4: UI'dan ayarlanabilir baud rate
      portRef.current = port;
      if (port.writable) {
        serialWriterRef.current = port.writable.getWriter();
      }
      setIsConnected(true);
      setConnectionType('SERIAL');
      addLog('INFO', 'GNSS Cihazı (USB/Bluetooth COM) bağlandı');
      showNotification('Cihaz başarıyla bağlandı! NMEA verisi bekleniyor...', 'success');

      const textDecoder = new TextDecoderStream();
      port.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();
      readerRef.current = reader;

      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          reader.releaseLock();
          break;
        }
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith('$GNGGA') || trimmedLine.startsWith('$GPGGA')) {
            lastGgaSentenceRef.current = trimmedLine;
            if (rtkStatusRef.current === 'CONNECTING' || rtkStatusRef.current === 'CONNECTED' || rtkStatusRef.current === 'FLOAT' || rtkStatusRef.current === 'FIXED') {
              sendGgaToNtrip();
            }
            const parsed = parseNMEA(trimmedLine);
            if (parsed) setCurrentPoint(applyPoleHeightCorrection(parsed));
          }
        }
      }
    } catch (error: any) {
      console.error(error);
      
      if (error.message && error.message.includes('No port selected')) {
        addLog('INFO', 'Seri port seçimi kullanıcı tarafından iptal edildi.');
        return;
      }
      
      addLog('ERROR', 'Seri Port bağlantı hatası', error);
      
      if (error.message && error.message.includes('permissions policy')) {
        showNotification('Tarayıcı güvenlik kısıtlaması! Lütfen sağ üstteki "Yeni Sekmede Aç" butonuna tıklayarak uygulamayı tam ekranda açın.', 'error');
      } else {
        showNotification(`Bağlantı hatası: ${error.message || 'Bilinmeyen hata'}`, 'error');
      }
      setIsConnected(false);
    }
  };

  const handlePhoneGPS = async () => {
    if (!('geolocation' in navigator)) {
      showNotification('Tarayıcınız konum servisini desteklemiyor.', 'error');
      return;
    }

    try {
      // Log permission status to help debugging
      const perm = await navigator.permissions.query({ name: 'geolocation' });
      addLog('INFO', `GPS İzin Durumu: ${perm.state}`);
      
      if (perm.state === 'denied') {
        showNotification('Konum izni daha önceden reddedilmiş. Lütfen tarayıcı ayarlarından izni açın.', 'error');
        return;
      }
    } catch (e) {
      addLog('INFO', 'İzin durumu sorgulanamadı, direkt denenecek.');
    }

    addLog('INFO', 'Telefon GPS Konum izni bekleniyor...');
    gpsSetupDoneRef.current = false;
    
    // First clear any existing watch
    if (geoWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(geoWatchIdRef.current);
    }

    const startWatching = (highAccuracy: boolean) => {
      geoWatchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
            if (!gpsSetupDoneRef.current) {
              gpsSetupDoneRef.current = true;
              setIsConnected(true);
              setConnectionType('SIMULATOR');
              setIsSimulationMode(true);
              showNotification('Telefon GPS test modu aktif.', 'success');
              addLog('INFO', `Telefon GPS (Hassas: ${highAccuracy}) Başlatıldı`);
            }
            setCurrentPoint({ 
              lat: pos.coords.latitude, 
              lon: pos.coords.longitude, 
              // BUG-4: Tüm NMEAData alanları dolduruldu
              alt: pos.coords.altitude ?? 100,
              mslAlt: pos.coords.altitude ?? 100,
              geoidSep: 0,
              fix: 1,
              satellites: 0,
              hdop: pos.coords.accuracy ? Math.max(1, pos.coords.accuracy / 10) : 5.0,
            });
        },
        (err) => {
            console.error('GPS Error:', err);
            
            if (err.code === 3 && highAccuracy) {
              addLog('INFO', 'Yüksek hassasiyetli konum alınamadı, standart konum deneniyor...');
              startWatching(false);
              return;
            }

            let msg = 'Konum hatası: ';
            if (err.code === 1) {
              msg = 'Konum izniniz yok. Lütfen sağ üstten "Yeni Sekmede Aç" butonuna basarak uygulamayı tam ekranda başlatın ve izin verin.';
            } else if (err.code === 2) {
              msg = 'Konum bilgisi şu an alınamıyor. Cihazınızda konumun açık olduğundan emin olun.';
            } else if (err.code === 3) {
              msg = 'Konum alma zaman aşımına uğradı. İç mekanda olabilirsiniz.';
            } else {
              msg += err.message || 'Bilinmeyen hata';
            }
            
            showNotification(msg, 'error');
            addLog('ERROR', `GPS Hatası (Kod ${err.code}): ${err.message}`);
            
            gpsSetupDoneRef.current = false;
            setIsConnected(false);
            setConnectionType('NONE');
            setIsSimulationMode(false);
        },
        { enableHighAccuracy: highAccuracy, timeout: 10000, maximumAge: 0 }
      );
    };

    // Bazı tarayıcılar watchPosition çağırmadan önce getCurrentPosition ile
    // temiz bir izin penceresi açmaya ihtiyaç duyar.
    navigator.geolocation.getCurrentPosition(
      () => {
        // İzin alındı, veri akışını başlat
        startWatching(true);
      },
      (err) => {
        // Eğer baştan patlarsa direkt watchPosition'ın hata yakalayıcısına benzer bir şey göster
        console.error('Initial GPS Error:', err);
        let msg = 'Konum izniniz yok. Lütfen sağ üstten "Yeni Sekmede Aç" butonuna basarak uygulamayı tam ekranda başlatın ve izin verin.';
        if (err.code !== 1) {
          msg = 'Konum sensörü başlatılamadı. Cihaz konumunuzun açık olduğundan emin olun.';
        }
        showNotification(msg, 'error');
        addLog('ERROR', `GPS İlk İstek Hatası (Kod ${err.code})`);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: Infinity }
    );
  };

  const handleConnectBLE = async () => {
    if (!('bluetooth' in navigator)) {
      showNotification('Tarayıcınız Web Bluetooth API desteklemiyor. Lütfen Chrome kullanın.', 'error');
      return;
    }

    const NORDIC_UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
    const NORDIC_UART_TX      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // cihaz→tarayıcı (notify)
    const NORDIC_UART_RX      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // tarayıcı→cihaz (write)

    try {
      if (isConnected) await disconnectDevice();

      // @ts-ignore
      let device: any;
      try {
        // @ts-ignore
        device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [NORDIC_UART_SERVICE] }],
          optionalServices: [NORDIC_UART_SERVICE],
        });
      } catch (filterErr: any) {
        if (filterErr.name === 'NotFoundError' || filterErr.message?.includes('User cancelled')) throw filterErr;
        addLog('INFO', 'Filtreli BLE tarama başarısız, geniş tarama deneniyor...');
        // @ts-ignore
        device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: [NORDIC_UART_SERVICE],
        });
      }

      addLog('INFO', `BLE cihazı seçildi: ${device.name || device.id}`);
      bleDeviceRef.current = device;

      const server = await device.gatt.connect();
      bleServerRef.current = server;
      addLog('INFO', 'BLE GATT sunucusuna bağlanıldı.');

      const service = await server.getPrimaryService(NORDIC_UART_SERVICE);
      const txChar = await service.getCharacteristic(NORDIC_UART_TX);
      const rxChar = await service.getCharacteristic(NORDIC_UART_RX);
      bleTxCharRef.current = txChar;
      bleRxCharRef.current = rxChar;

      await txChar.startNotifications();

      let nmeaBuffer = '';
      const decoder = new TextDecoder();
      txChar.addEventListener('characteristicvaluechanged', (event: any) => {
        nmeaBuffer += decoder.decode((event.target.value as DataView).buffer, { stream: true });
        const lines = nmeaBuffer.split('\n');
        nmeaBuffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (line.startsWith('$GNGGA') || line.startsWith('$GPGGA')) {
            lastGgaSentenceRef.current = line;
            const parsed = parseNMEA(line);
            if (parsed) {
              const corrected = applyPoleHeightCorrection(parsed);
              setCurrentPoint(corrected);
              if (
                rtkShouldRunRef.current &&
                rtkStatusRef.current !== 'ERROR' &&
                rtkStatusRef.current !== 'DISCONNECTED' &&
                rtkStatusRef.current !== 'OFF'
              ) {
                const derived = getFixDerivedRtkStatus(corrected, rtkStatusRef.current);
                if (derived === 'FIXED' || derived === 'FLOAT') setRtkStatus(derived);
              }
            }
          }
        }
      });

      // RTCM byte'larını 20-byte BLE chunk'larıyla cihaza yaz
      const BLE_MTU = 20;
      serialWriterRef.current = {
        write: async (bytes: Uint8Array) => {
          const char = bleRxCharRef.current;
          if (!char) throw new Error('BLE RX karakteristiği hazır değil.');
          for (let offset = 0; offset < bytes.length; offset += BLE_MTU) {
            await char.writeValueWithoutResponse(bytes.slice(offset, offset + BLE_MTU));
          }
        },
        releaseLock: () => {},
      } as any;

      device.addEventListener('gattserverdisconnected', () => {
        addLog('WARN', 'BLE cihazı bağlantıyı kesti.');
        serialWriterRef.current = null;
        bleServerRef.current = null;
        bleTxCharRef.current = null;
        bleRxCharRef.current = null;
        setIsConnected(false);
        setConnectionType('NONE');
        if (rtkShouldRunRef.current) {
          setRtkStatus('DISCONNECTED');
          setRtkMessage('BLE bağlantısı kesildi — yeniden deneniyor...');
          scheduleRtkReconnectRef.current?.();
        }
      });

      setIsConnected(true);
      setConnectionType('SERIAL');
      setIsSimulationMode(false);
      addLog('INFO', `BLE NUS bağlandı: ${device.name || device.id}`);
      showNotification(`BLE RTK cihazı bağlandı: ${device.name || device.id}`, 'success');

    } catch (error: any) {
      if (error.name === 'NotFoundError' || error.message?.includes('User cancelled')) {
        addLog('INFO', 'BLE cihaz seçimi iptal edildi.');
        return;
      }
      if (error.message?.includes('globally disabled')) {
        showNotification('Web Bluetooth bu pencerede devre dışı. Uygulamayı tam ekranda açın.', 'info');
        return;
      }
      if (error.message?.includes('permissions policy')) {
        showNotification('Tarayıcı güvenlik kısıtlaması! Sağ üstteki "Yeni Sekmede Aç" butonuna tıklayın.', 'error');
        return;
      }
      addLog('ERROR', 'BLE GATT bağlantı hatası', error);
      showNotification(`BLE Hatası: ${error.message || 'Bağlantı başarısız'}`, 'error');
      serialWriterRef.current = null;
      setIsConnected(false);
      setConnectionType('NONE');
    }
  };

  // --- UI HELPERS ---
  const getStatusUI = () => {
    switch (metrics.direction) {
      case 'OK': 
        return {
          color: 'text-emerald-400',
          bg: 'bg-emerald-500/20 border-emerald-500/40',
          icon: <CheckCircle className="w-12 h-12 sm:w-16 sm:h-16 text-emerald-400" />,
          title: 'TAMAM',
          subtitle: 'Hedeflenen Mesafe'
        };
      case 'BACK': 
        return {
          color: 'text-rose-500',
          bg: 'bg-rose-500/20 border-rose-500/40',
          icon: <ArrowDown className="w-12 h-12 sm:w-16 sm:h-16 text-rose-500 animate-bounce" />,
          title: 'GERİ',
          subtitle: 'Fazla gittiniz'
        };
      case 'FORWARD': 
        return {
          color: 'text-sky-400',
          bg: 'bg-sky-500/20 border-sky-500/40',
          icon: <ArrowUp className="w-12 h-12 sm:w-16 sm:h-16 text-sky-400 animate-bounce" />,
          title: 'İLERİ',
          subtitle: 'Yaklaşmanız gerek'
        };
      case 'APPROACHING': 
        return {
          color: 'text-amber-400',
          bg: 'bg-amber-500/20 border-amber-500/40',
          icon: <ArrowUp className="w-12 h-12 sm:w-16 sm:h-16 text-amber-400 animate-pulse" />,
          title: 'YAKLAŞIYORSUNUZ',
          subtitle: 'Doğru Yön'
        };
      case 'RECEDING': 
        return {
          color: 'text-rose-500',
          bg: 'bg-rose-500/20 border-rose-500/40',
          icon: <ArrowDown className="w-12 h-12 sm:w-16 sm:h-16 text-rose-500 animate-bounce" />,
          title: 'UZAKLAŞIYORSUNUZ',
          subtitle: 'Yanlış Yön'
        };
      case 'QUALITY_WAIT':
        return {
          color: 'text-amber-300',
          bg: 'bg-amber-500/20 border-amber-500/40',
          icon: <Activity className="w-12 h-12 sm:w-16 sm:h-16 text-amber-300 animate-pulse" />,
          title: 'KALİTE BEKLENİYOR',
          subtitle: metrics.qualityReason
        };
      default: 
        return {
          color: 'text-slate-400',
          bg: 'bg-slate-800/80 border-slate-700',
          icon: <Activity className="w-12 h-12 sm:w-16 sm:h-16 text-slate-500 animate-pulse" />,
          title: 'BEKLENİYOR',
          subtitle: 'Mesafe Analizi'
        };
    }
  };

  const statusUI = getStatusUI();
  const canStartRtk = isConnected && (nativeAndroidGnss ? connectionType === 'ANDROID_BT' : connectionType === 'SERIAL');
  const rtkActive = rtkStatus === 'CONNECTED' || rtkStatus === 'CONNECTING' || rtkStatus === 'FLOAT' || rtkStatus === 'FIXED';
  const pointStakeoutMode = targetMode === 'POINT';
  const activeGuidancePoint = pointStakeoutMode ? slopeCorrectedTarget : referencePoint;
  const guidanceReady = isConnected && (pointStakeoutMode ? Boolean(selectedNCNTarget) : Boolean(referencePoint && targetDistance > 0));
  const currentQuality = evaluateRtkQuality(currentPoint, accuracyMode, metrics.residualRMS, metrics.surfaceCorrected);
  const currentFixInfo = currentPoint ? displayFixLabel((currentPoint as any).fix ?? 1, connectionType) : null;
  const connectionTitle =
    connectionType === 'SIMULATOR' ? 'Telefon GPS' :
    connectionType === 'ANDROID_BT' ? 'Android SPP' :
    connectionType === 'SERIAL' ? 'COM Port' :
    connectionType === 'BLE' ? 'BLE' : 'Bagli degil';
  const targetSummaryLabel = pointStakeoutMode
    ? (selectedNCNTarget?.name || 'Nokta sec')
    : `${targetDistance.toFixed(2)} m hedef`;
  const liveDistanceValue = pointStakeoutMode ? metrics.plane2dDistance : metrics.surface3dDistance;
  const liveDistanceDetail = formatDistanceDetail(liveDistanceValue);
  const sectionActions = [
    { key: 'connection' as SectionKey, icon: Plug, label: 'Baglanti', accent: isConnected ? 'emerald' : 'slate', dot: isConnected ? 'bg-emerald-400' : 'bg-slate-600' },
    { key: 'pole' as SectionKey, icon: Ruler, label: 'Jalon', accent: 'indigo', dot: 'bg-indigo-400' },
    { key: 'accuracy' as SectionKey, icon: Gauge, label: 'Hassasiyet', accent: currentQuality.ok ? 'emerald' : 'amber', dot: currentQuality.ok ? 'bg-emerald-400' : 'bg-amber-400' },
    { key: 'rtk' as SectionKey, icon: Radio, label: 'RTK', accent: rtkActive ? 'emerald' : 'slate', dot: rtkActive ? 'bg-emerald-400' : 'bg-slate-600' },
    { key: 'p1' as SectionKey, icon: MapPin, label: 'P1', accent: referencePoint ? 'sky' : 'slate', dot: referencePoint ? 'bg-sky-400' : 'bg-slate-600' },
    { key: 'target' as SectionKey, icon: Target, label: 'Hedef', accent: guidanceReady ? 'emerald' : 'slate', dot: guidanceReady ? 'bg-emerald-400' : 'bg-slate-600' },
  ] as const;
  const getSectionTone = (active: boolean, accent: 'emerald' | 'slate' | 'indigo' | 'amber' | 'sky') => {
    if (!active) return 'bg-slate-900/80 border-slate-800 text-slate-400';
    if (accent === 'emerald') return 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200';
    if (accent === 'indigo') return 'bg-indigo-500/15 border-indigo-500/40 text-indigo-200';
    if (accent === 'amber') return 'bg-amber-500/15 border-amber-500/40 text-amber-200';
    if (accent === 'sky') return 'bg-sky-500/15 border-sky-500/40 text-sky-200';
    return 'bg-slate-800/90 border-slate-700 text-slate-100';
  };

  return (
    <div className="field-ui h-dvh min-h-dvh text-stone-100 font-sans selection:bg-cyan-400/25 flex flex-col overflow-hidden safe-x">
      
      {/* --- TOP NAVIGATION --- */}
      <header className="field-topbar shrink-0 z-40 safe-top">
        <div className="max-w-7xl mx-auto px-3 sm:px-4">
          <div className="h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 sm:gap-3 shrink-0 min-w-0">
            <div className="field-brand-mark w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center relative overflow-hidden">
              <svg viewBox="0 0 40 40" className="w-9 h-9" fill="none" aria-hidden="true">
                <defs>
                  <linearGradient id="brand-grad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#67e8f9" />
                    <stop offset="55%" stopColor="#a7f3d0" />
                    <stop offset="100%" stopColor="#bef264" />
                  </linearGradient>
                  <linearGradient id="brand-arc" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#67e8f9" stopOpacity="0" />
                    <stop offset="50%" stopColor="#67e8f9" stopOpacity="0.9" />
                    <stop offset="100%" stopColor="#bef264" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M8 11 Q20 4 32 11" stroke="url(#brand-arc)" strokeWidth="1.4" strokeLinecap="round" fill="none" />
                <path d="M12 14 Q20 9 28 14" stroke="url(#brand-arc)" strokeWidth="1.1" strokeLinecap="round" fill="none" opacity="0.55" />
                <circle cx="20" cy="7.5" r="1.7" fill="#bef264" />
                <text x="20" y="33" textAnchor="middle" fontSize="19" fontWeight="900" fill="url(#brand-grad)" fontFamily="ui-sans-serif, system-ui, sans-serif" letterSpacing="-1.2">3a</text>
              </svg>
            </div>
            <div className="hidden sm:block">
              <h1 className="text-lg font-black tracking-tight leading-tight">
                <span className="bg-gradient-to-br from-cyan-300 via-teal-200 to-lime-300 bg-clip-text text-transparent">3a</span>
                <span className="ml-1 text-stone-50">RTK</span>
              </h1>
              <div className="flex items-center gap-1">
                <WifiOff className="w-3 h-3 text-lime-300" />
                <span className="text-[10px] font-black text-lime-200 tracking-wider">FIELD READY</span>
              </div>
            </div>
          </div>
          <div className="hidden sm:flex items-center justify-end gap-0.5 sm:gap-2 min-w-0 overflow-x-auto scrollbar-hide">
            {/* Section toolbar: 6 quick-access panel icons */}
            {([
              { key: 'connection' as SectionKey, icon: Plug, label: 'Bağlantı',
                accent: isConnected ? 'emerald' : 'sky',
                dot: isConnected ? 'bg-emerald-400' : (connectionType ? 'bg-amber-400' : 'bg-slate-600') },
              { key: 'pole' as SectionKey, icon: Ruler, label: 'Jalon',
                accent: 'indigo', dot: 'bg-indigo-400' },
              { key: 'accuracy' as SectionKey, icon: Gauge, label: 'Hassasiyet',
                accent: 'emerald', dot: currentQuality.ok ? 'bg-emerald-400' : 'bg-amber-400' },
              { key: 'rtk' as SectionKey, icon: Radio, label: 'RTK',
                accent: rtkStatus === 'FIXED' || rtkStatus === 'CONNECTED' ? 'emerald' : rtkStatus === 'ERROR' ? 'rose' : 'slate',
                dot: rtkStatus === 'FIXED' || rtkStatus === 'CONNECTED' ? 'bg-emerald-400' :
                     rtkStatus === 'FLOAT' || rtkStatus === 'CONNECTING' ? 'bg-amber-400' :
                     rtkStatus === 'ERROR' ? 'bg-rose-400' : 'bg-slate-600' },
              { key: 'p1' as SectionKey, icon: MapPin, label: 'P1',
                accent: referencePoint ? 'sky' : 'slate', dot: referencePoint ? 'bg-sky-400' : 'bg-slate-600' },
              { key: 'target' as SectionKey, icon: Target, label: 'Hedef',
                accent: guidanceReady ? 'emerald' : 'slate', dot: guidanceReady ? 'bg-emerald-400' : 'bg-slate-600' },
            ]).map(({ key, icon: Icon, label, accent, dot }) => {
              const active = activeSection === key;
              const ring = active
                ? accent === 'emerald' ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-200 ring-1 ring-emerald-500/30' :
                  accent === 'sky'     ? 'bg-sky-500/20 border-sky-500/60 text-sky-200 ring-1 ring-sky-500/30' :
                  accent === 'indigo'  ? 'bg-indigo-500/20 border-indigo-500/60 text-indigo-200 ring-1 ring-indigo-500/30' :
                  accent === 'rose'    ? 'bg-rose-500/20 border-rose-500/60 text-rose-200 ring-1 ring-rose-500/30' :
                                         'bg-slate-700/40 border-slate-500/60 text-slate-100 ring-1 ring-slate-500/30'
                : 'bg-slate-800/60 border-slate-700 hover:bg-slate-700/70 text-slate-300';
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveSection(prev => (prev === key ? null : key))}
                  className={`relative w-8 h-8 sm:w-10 sm:h-10 rounded-xl border transition-all active:scale-95 flex items-center justify-center shrink-0 ${ring}`}
                  title={label}
                  aria-label={label}
                  aria-pressed={active}
                >
                  <Icon className="w-4 h-4 sm:w-4 sm:h-4" />
                  <span className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden="true" />
                </button>
              );
            })}

            {/* Divider */}
            <span className="hidden sm:inline-block w-px h-6 bg-slate-700/70 mx-1" aria-hidden="true" />

            {/* Kalibrasyon — sadece TEST modunda */}
            {accuracyMode === 'TEST' && (
            <button
              onClick={() => setShowCalibration(true)}
              className="w-8 h-8 sm:w-10 sm:h-10 bg-indigo-500/10 hover:bg-indigo-500/20 active:bg-indigo-500/30 rounded-xl border border-indigo-500/30 transition-all text-indigo-400 font-bold flex items-center justify-center gap-2 active:scale-95 shrink-0"
              title="Cihaz Kalibrasyonu"
              aria-label="Cihaz Kalibrasyonu"
            >
              <Ruler className="w-5 h-5 sm:w-4 sm:h-4" />
            </button>
            )}

            <button
              onClick={() => setShowLogs(true)}
              className="w-8 h-8 sm:w-10 sm:h-10 bg-slate-800/80 rounded-xl hover:bg-slate-700 active:bg-slate-600 border border-slate-700 transition-all flex items-center justify-center active:scale-95 shrink-0"
              title="Sistem Logları"
              aria-label="Sistem Logları"
            >
              <Terminal className="w-5 h-5 sm:w-4 sm:h-4 text-slate-300" />
            </button>

            {/* Voice Toggle Button */}
            <button
              onClick={() => {
                setIsVoiceEnabled(!isVoiceEnabled);
                if (!isVoiceEnabled) {
                  const utterance = new SpeechSynthesisUtterance("Sesli asistan aktif");
                  utterance.lang = 'tr-TR';
                  window.speechSynthesis.speak(utterance);
                } else {
                  window.speechSynthesis.cancel();
                }
              }}
              className={`w-8 h-8 sm:w-10 sm:h-10 rounded-xl border transition-all flex items-center justify-center gap-2 active:scale-95 shrink-0 ${
                isVoiceEnabled
                  ? 'bg-emerald-500/10 hover:bg-emerald-500/20 active:bg-emerald-500/30 text-emerald-400 border-emerald-500/30'
                  : 'bg-slate-800/80 hover:bg-slate-700 active:bg-slate-600 text-slate-400 border-slate-700'
              }`}
              title={isVoiceEnabled ? "Sesi Kapat" : "Sesli Yönlendirmeyi Aç"}
              aria-label={isVoiceEnabled ? "Sesi Kapat" : "Sesli Yönlendirmeyi Aç"}
              aria-pressed={isVoiceEnabled}
            >
              {isVoiceEnabled ? <Volume2 className="w-5 h-5 sm:w-4 sm:h-4" /> : <VolumeX className="w-5 h-5 sm:w-4 sm:h-4" />}
            </button>
            
            {/* Connect Button Dropdown REMOVED FROM HERE, MOVED TO STEP 1 */}
          </div>

          <div className="flex sm:hidden items-center gap-2">
            {accuracyMode === 'TEST' && (
              <button
                onClick={() => setShowCalibration(true)}
                className="w-10 h-10 bg-indigo-500/10 hover:bg-indigo-500/20 active:bg-indigo-500/30 rounded-2xl border border-indigo-500/30 transition-all text-indigo-400 flex items-center justify-center active:scale-95"
                title="Cihaz Kalibrasyonu"
                aria-label="Cihaz Kalibrasyonu"
              >
                <Ruler className="w-5 h-5" />
              </button>
            )}
            <button
              onClick={() => setShowLogs(true)}
              className="w-10 h-10 bg-slate-800/80 rounded-2xl hover:bg-slate-700 active:bg-slate-600 border border-slate-700 transition-all flex items-center justify-center active:scale-95"
              title="Sistem Loglari"
              aria-label="Sistem Loglari"
            >
              <Terminal className="w-5 h-5 text-slate-300" />
            </button>
          </div>
          </div>

          <div className="field-mobile-strip sm:hidden pb-3">
            <div className="field-mobile-pill">
              <span className="field-mobile-pill-label">Baglanti</span>
              <strong className="truncate text-xs text-white">{connectionTitle}</strong>
            </div>
            <div className="field-mobile-pill">
              <span className="field-mobile-pill-label">Fix</span>
              <strong className="truncate text-xs" style={{ color: currentFixInfo?.color || '#e2e8f0' }}>
                {currentFixInfo?.label || 'GPS bekleniyor'}
              </strong>
            </div>
            <div className="field-mobile-pill">
              <span className="field-mobile-pill-label">Hedef</span>
              <strong className="truncate text-xs text-white">{targetSummaryLabel}</strong>
            </div>
            <div className="field-mobile-pill">
              <span className="field-mobile-pill-label">Mesafe</span>
              <strong className="truncate text-xs text-cyan-200">{liveDistanceDetail.val} {liveDistanceDetail.unit}</strong>
            </div>
          </div>
        </div>
      </header>

      {/* --- MAIN DASHBOARD --- */}
      <main className="field-main flex-1 overflow-y-auto lg:overflow-hidden p-3 pb-[calc(env(safe-area-inset-bottom)+6.5rem)] lg:p-6 scroll-y-touch">
        <div className="max-w-7xl mx-auto w-full min-h-full lg:h-full flex flex-col lg:flex-row gap-4 lg:gap-6">
          
          {/* SECTION DRAWER (conditional overlay, replaces old left panel) */}
          {activeSection && (
          <div
            className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
            onClick={() => setActiveSection(null)}
            role="presentation"
          >
            <aside
              onClick={e => e.stopPropagation()}
              className="field-control-dock absolute inset-x-0 bottom-0 h-[78dvh] w-full max-w-full bg-slate-900/97 border-t border-slate-800 shadow-2xl flex flex-col rounded-t-[28px] sm:left-0 sm:top-0 sm:bottom-0 sm:h-auto sm:w-[400px] sm:rounded-none sm:border-t-0 sm:border-r"
              role="dialog"
              aria-modal="true"
            >
              <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-800/80 safe-top">
                <h2 className="text-sm font-bold text-white truncate">
                  {activeSection === 'connection' ? 'Cihaz Bağlantısı' :
                   activeSection === 'pole' ? 'Jalon / Anten Yüksekliği' :
                   activeSection === 'accuracy' ? 'Hassasiyet Modu' :
                   activeSection === 'rtk' ? 'RTK Düzeltmesi' :
                   activeSection === 'p1' ? 'Başlangıç Noktası (P1)' :
                   'Hedef Mesafe veya Seçim'}
                </h2>
                <button
                  type="button"
                  onClick={() => setActiveSection(null)}
                  className="touch-target p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors shrink-0"
                  aria-label="Kapat"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto scroll-y-touch scrollbar-hide px-3 pt-3 pb-6 space-y-3 safe-bottom">

            {activeSection === 'connection' && (
            <>
            {/* 1. BAĞLANTI (CONNECTION) */}
            <div className={`bg-slate-900/80 border ${!isConnected ? 'border-sky-500/50 ring-1 ring-sky-500/30' : 'border-emerald-500/30'} rounded-2xl p-3 shadow-lg backdrop-blur-sm transition-all duration-300`}>
              <h2 className="text-xs font-bold text-white mb-2 flex items-center justify-between gap-2">
                <span className={`w-5 h-5 rounded-lg flex items-center justify-center text-[10px] ${!isConnected ? 'bg-sky-500 text-white' : 'bg-emerald-500 text-white'}`}>1</span>
                Cihaz Bağlantısı
                <span className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${isConnected ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : 'bg-slate-950 text-slate-500 border-slate-800'}`}>{connectionTitle}</span>
              </h2>
              
              {isConnected ? (
                <div className="grid grid-cols-[1fr_44px] gap-2">
                  <div className="flex items-center justify-between px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl min-w-0">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span className="text-xs font-bold text-emerald-400 truncate">
                        {connectionType === 'SIMULATOR' ? 'Test (Telefon GPS) Aktif' : 'Cihaz Bağlı'}
                      </span>
                    </div>
                  </div>
                  <button onClick={disconnectDevice} className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-sm font-bold transition-all border border-slate-700">Bağlantıyı Kes</button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {/* Baud Rate Seçici */}
                  {nativeAndroidGnss && (
                    <>
                      <div className="grid grid-cols-[1fr_96px] gap-2">
                        <select
                          value={selectedAndroidDevice}
                          onChange={(e) => setSelectedAndroidDevice(e.target.value)}
                          onFocus={() => {
                            if (androidDevices.length === 0) void refreshAndroidBluetoothDevices();
                          }}
                          className="bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-300 px-3 py-3 focus:outline-none focus:border-sky-500"
                        >
                          <option value="">RTK cihaz sec</option>
                          {androidDevices.map(device => (
                            <option key={device.address} value={device.address}>{device.name || device.address}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={refreshAndroidBluetoothDevices}
                          className="touch-target bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-bold border border-slate-700"
                        >
                          Eslesmisleri Yenile
                        </button>
                      </div>
                      <button
                        onClick={handleConnectAndroidBluetooth}
                        className="w-full flex items-center justify-between px-3 py-2 bg-slate-800 hover:bg-sky-600/20 rounded-xl hover:border-sky-500/50 border border-slate-700 transition-all text-left group"
                      >
                        <div>
                          <p className="text-sm font-bold text-white group-hover:text-sky-400 transition-colors">Android Bluetooth SPP</p>
                          <p className="text-[10px] text-slate-400 mt-0.5">RTK alicisindan NMEA oku, RTCM yaz</p>
                        </div>
                        <Bluetooth className="w-4 h-4 text-slate-500 group-hover:text-sky-400" />
                      </button>
                    </>
                  )}
                  {!nativeAndroidGnss && (
                    <>
                  <div className="flex items-center gap-2 mb-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest shrink-0">Baud Rate</label>
                    <select
                      value={baudRate}
                      onChange={(e) => setBaudRate(Number(e.target.value))}
                      className="flex-1 bg-slate-800 border border-slate-700 rounded-lg text-xs font-mono text-slate-300 px-2 py-1.5 focus:outline-none focus:border-sky-500"
                    >
                      <option value={9600}>9600</option>
                      <option value={38400}>38400 (Önerilen)</option>
                      <option value={57600}>57600</option>
                      <option value={115200}>115200</option>
                    </select>
                  </div>
                  <button 
                    onClick={handleConnectSerial}
                    className="w-full flex items-center justify-between px-3 py-2 bg-slate-800 hover:bg-sky-600/20 border-b lg:border-none lg:rounded-t-xl hover:border-sky-500/50 border-slate-700 transition-all text-left group"
                  >
                    <div>
                      <p className="text-sm font-bold text-white group-hover:text-sky-400 transition-colors">USB / Bluetooth (COM)</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">Eşleştirilmiş RTK donanımları</p>
                    </div>
                    <Usb className="w-4 h-4 text-slate-500 group-hover:text-sky-400" />
                  </button>
                  <button 
                    onClick={handleConnectBLE}
                    className="w-full flex items-center justify-between px-3 py-2 bg-slate-800 hover:bg-indigo-600/20 border-b lg:border-none hover:border-indigo-500/50 border-slate-700 transition-all text-left group"
                  >
                    <div>
                      <p className="text-sm font-bold text-white group-hover:text-indigo-400 transition-colors">Bluetooth LE Taraması</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">Harman / Android dahil BLE cihazları</p>
                    </div>
                    <Bluetooth className="w-4 h-4 text-slate-500 group-hover:text-indigo-400" />
                  </button>
                    </>
                  )}
                  <button 
                    onClick={handlePhoneGPS}
                    className="w-full flex items-center justify-between px-3 py-2 bg-slate-800 hover:bg-emerald-600/20 lg:rounded-b-xl hover:border-emerald-500/50 border border-transparent transition-all text-left group"
                  >
                    <div>
                      <p className="text-sm font-bold text-white group-hover:text-emerald-400 transition-colors">Telefon GPS (Test)</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">Donanımsız yönlendirme testi</p>
                    </div>
                    <Crosshair className="w-4 h-4 text-slate-500 group-hover:text-emerald-400" />
                  </button>
                </div>
              )}
            </div>
            </>
            )}

            {/* MEASUREMENT SETUP */}
            {activeSection === 'pole' && (
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-3 shadow-lg backdrop-blur-sm transition-all duration-300">
              <button
                type="button"
                onClick={() => setPolePanelOpen(prev => !prev)}
                className="w-full touch-target flex items-center justify-between gap-3 text-left"
              >
                <span className="text-xs font-bold text-white flex items-center gap-2">
                  <Ruler className="w-4 h-4 text-indigo-400" />
                  Jalon / Anten Yuksekligi
                </span>
                <span className="text-xs font-mono font-bold text-indigo-300">{poleHeight.toFixed(3)} m</span>
              </button>
              {polePanelOpen && (
                <div className="mt-2 space-y-2">
                  <div className="grid grid-cols-[1fr_74px] gap-2 items-center">
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      value={poleHeight}
                      onChange={(e) => setPoleHeight(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-base font-mono text-indigo-300 focus:outline-none focus:border-indigo-500"
                    />
                    <span className="text-xs font-bold text-slate-500">metre</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[1.5, 2.0, 2.5].map(height => (
                      <button
                        key={height}
                        type="button"
                        onClick={() => setPoleHeight(height)}
                        className="py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-800 text-[10px] font-mono text-slate-300"
                      >
                        {height.toFixed(2)}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setPolePanelOpen(false)}
                    className="w-full touch-target py-2.5 bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-200 rounded-xl text-xs font-bold border border-indigo-500/30"
                  >
                    Tamam
                  </button>
                  <p className="text-[10px] text-slate-500 leading-relaxed">GNSS anten yuksekligi zemindeki jalon ucuna indirilir. RTK aplikasyon ve kot hesabinda bu deger kritiktir.</p>
                </div>
              )}
              {currentPoint?.antennaAlt !== undefined && (
                <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-slate-500">
                  <span>Anten Z: {currentPoint.antennaAlt.toFixed(3)}</span>
                  <span>Uc Z: {currentPoint.alt.toFixed(3)}</span>
                </div>
              )}
            </div>
            )}

            {activeSection === 'accuracy' && (
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-3 shadow-lg backdrop-blur-sm transition-all duration-300">
              <h2 className="text-xs font-bold text-white mb-2 flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400" />
                Hassasiyet Modu
                </span>
                <span className={`text-[10px] font-bold truncate max-w-[150px] ${currentQuality.ok ? 'text-emerald-300' : 'text-amber-300'}`}>{currentQuality.reason}</span>
              </h2>
              <div className="grid grid-cols-3 gap-1.5">
                {(Object.keys(ACCURACY_MODE_LABELS) as AccuracyMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setAccuracyMode(mode)}
                    className={`px-1.5 py-1.5 rounded-xl border text-[9px] font-bold transition-all ${
                      accuracyMode === mode
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {ACCURACY_MODE_LABELS[mode]}
                  </button>
                ))}
              </div>
            </div>
            )}

            {/* 2. BAŞLANGIÇ NOKTASI (P1) */}
            {/* RTK / NTRIP CORRECTION */}
            {activeSection === 'rtk' && (
            <div className={`bg-slate-900/80 border ${rtkStatus === 'CONNECTED' || rtkStatus === 'FIXED' ? 'border-emerald-500/40' : rtkStatus === 'FLOAT' ? 'border-amber-500/40' : rtkStatus === 'ERROR' ? 'border-rose-500/40' : 'border-slate-800'} rounded-2xl p-3 shadow-lg backdrop-blur-sm transition-all duration-300`}>
              <h2 className="text-xs font-bold text-white mb-2 flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Activity className={`w-4 h-4 ${rtkStatus === 'CONNECTED' || rtkStatus === 'FIXED' ? 'text-emerald-400' : rtkStatus === 'FLOAT' || rtkStatus === 'CONNECTING' ? 'text-amber-400' : rtkStatus === 'ERROR' ? 'text-rose-400' : 'text-slate-500'}`} />
                  RTK Duzeltmesi
                </span>
                <span className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${
                  rtkStatus === 'CONNECTED' || rtkStatus === 'FIXED' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                  rtkStatus === 'FLOAT' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' :
                  rtkStatus === 'CONNECTING' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' :
                  rtkStatus === 'ERROR' ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' :
                  'bg-slate-800 text-slate-400 border-slate-700'
                }`}>
                  {rtkStatus}
                </span>
                <button
                  type="button"
                  onClick={() => setRtkSettingsOpen(prev => !prev)}
                  className={`touch-target -my-2 -mr-2 rounded-xl border flex items-center justify-center transition-all ${rtkSettingsOpen ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'}`}
                  title="RTK duzeltme ayarlari"
                  aria-label="RTK duzeltme ayarlari"
                  aria-expanded={rtkSettingsOpen}
                >
                  <Settings2 className="w-4 h-4" />
                </button>
              </h2>

              <div className="space-y-2">
                {rtkSettingsOpen && (
                  <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={applyTusagaPreset}
                    className="py-2 bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 rounded-xl text-xs font-bold border border-sky-500/30 transition-all"
                  >
                    TUSAGA Hazirla
                  </button>
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) setRtkConfig(prev => ({ ...prev, mountPoint: e.target.value }));
                    }}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-2 py-2 text-xs text-slate-300 focus:outline-none focus:border-sky-500"
                  >
                    <option value="">Mount sec</option>
                    {TUSAGA_MOUNTPOINTS.map(mp => <option key={mp} value={mp}>{mp}</option>)}
                  </select>
                </div>

                <div className="grid grid-cols-[1fr_86px] gap-2">
                  <input
                    value={rtkConfig.host}
                    onChange={(e) => setRtkConfig(prev => ({ ...prev, host: e.target.value }))}
                    placeholder="caster host"
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                  <input
                    value={rtkConfig.port}
                    onChange={(e) => setRtkConfig(prev => ({ ...prev, port: e.target.value }))}
                    placeholder="2101"
                    inputMode="numeric"
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                </div>

                <input
                  value={rtkConfig.mountPoint}
                  onChange={(e) => setRtkConfig(prev => ({ ...prev, mountPoint: e.target.value }))}
                  placeholder="mountpoint"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                />

                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={rtkConfig.username}
                    onChange={(e) => setRtkConfig(prev => ({ ...prev, username: e.target.value }))}
                    placeholder="kullanici"
                    autoComplete="username"
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                  <input
                    value={rtkConfig.password}
                    onChange={(e) => setRtkConfig(prev => ({ ...prev, password: e.target.value }))}
                    placeholder="sifre"
                    type="password"
                    autoComplete="current-password"
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                </div>

                <label className="flex items-center justify-between gap-3 p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-300">
                  <span>TLS / SSL kullan</span>
                  <input
                    type="checkbox"
                    checked={rtkConfig.useTls}
                    onChange={(e) => setRtkConfig(prev => ({ ...prev, useTls: e.target.checked }))}
                    className="w-4 h-4 accent-sky-500"
                  />
                </label>
                  </div>
                )}

                {rtkActive ? (
                  <button
                    onClick={stopRtkCorrection}
                    className="w-full py-2.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 rounded-xl text-xs font-bold transition-all border border-rose-500/30"
                  >
                    Durdur
                  </button>
                ) : (
                  <button
                    onClick={startRtkCorrection}
                    disabled={!canStartRtk}
                    className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all border border-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    NTRIP Baslat
                  </button>
                )}

                <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                  <span className="truncate pr-2">{rtkMessage}</span>
                  <span className="shrink-0">{(rtkBytes / 1024).toFixed(1)} KB</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-slate-500">
                  <div className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1">
                    RTCM/s: <span className="text-slate-300">{(rtkBytesPerSecond / 1024).toFixed(1)} KB</span>
                  </div>
                  <div className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1">
                    GGA: <span className="text-slate-300">{formatAge(rtkLastGgaAt)}</span>
                  </div>
                  <div className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1">
                    RTCM: <span className={
                      rtkLastRtcmAt && Date.now() - rtkLastRtcmAt > 30_000 ? 'text-rose-600 animate-pulse' :
                      rtkLastRtcmAt && Date.now() - rtkLastRtcmAt > 5_000 ? 'text-rose-400' :
                      'text-slate-300'
                    }>{formatAge(rtkLastRtcmAt)}</span>
                  </div>
                  <div className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1">
                    Fixed: <span className="text-slate-300">{formatAge(rtkFixedSince)}</span>
                  </div>
                </div>
              </div>
            </div>
            )}

            {activeSection === 'p1' && (
            <div className={`bg-slate-900/80 border ${isConnected && !pointStakeoutMode && !referencePoint ? 'border-sky-500/50 ring-1 ring-sky-500/30' : 'border-slate-800'} ${!isConnected ? 'opacity-50 pointer-events-none' : ''} rounded-2xl p-3 sm:p-4 shadow-lg backdrop-blur-sm transition-all duration-300`}>
              <h2 className="text-sm font-bold text-white mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${isConnected && !pointStakeoutMode && !referencePoint ? 'bg-sky-500 text-white' : 'bg-slate-800 text-slate-400'}`}>2</span>
                  Başlangıç Noktası (P1)
                </div>
                {referencePoint && (
                   <button onClick={() => setReferencePoint(null)} className="text-xs font-bold text-slate-500 hover:text-rose-500 transition-colors">Yeniden Seç</button>
                )}
              </h2>

              {referencePoint ? (
                <div className="p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-xl space-y-1">
                  <div className="flex items-center gap-2 text-indigo-400 font-bold text-sm">
                    <MapPin className="w-4 h-4" />
                    P1 Ayarlandı
                  </div>
                  <p className="text-xs font-mono text-slate-400 truncate">
                    Y: {referencePoint.lon.toFixed(5)} X: {referencePoint.lat.toFixed(5)}
                  </p>
                  <div className="grid grid-cols-2 gap-2 pt-2">
                    <button
                      type="button"
                      onClick={handleSetReference}
                      disabled={!currentPoint}
                      className="py-2 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-200 border border-indigo-500/25 text-[10px] font-bold disabled:opacity-50"
                    >
                      Guncelle
                    </button>
                    <button
                      type="button"
                      onClick={() => setReferencePoint(null)}
                      className="py-2 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 text-[10px] font-bold"
                    >
                      Temizle
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                <button 
                  onClick={handleSetReference}
                  disabled={!currentPoint}
                  className="w-full bg-slate-800 hover:bg-sky-600 hover:text-white text-slate-300 font-bold py-3 px-4 rounded-xl border border-slate-700 hover:border-sky-500 transition-all disabled:opacity-50 flex items-center gap-2 text-sm justify-center"
                >
                  <MapPin className="w-4 h-4" />
                  Mevcut Konumu Başlangıç (P1) Yap
                </button>

                <div className="flex items-center py-1">
                  <div className="flex-1 border-t border-slate-700"></div>
                  <span className="px-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">VEYA PROJEDEN SEÇ</span>
                  <div className="flex-1 border-t border-slate-700"></div>
                </div>

                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 flex justify-center items-center gap-1.5 text-xs bg-slate-800 text-slate-300 py-3 rounded-xl font-bold hover:bg-slate-700 transition-colors border border-slate-700"
                  >
                    <Upload className="w-4 h-4" /> Proje Yükle (.ncn, .dxf)
                  </button>
                  {importedPoints.length > 0 && (
                    <button
                      type="button"
                      onClick={handleClearImportedPoints}
                      className="px-3 py-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 transition-colors"
                      title="Yuklenen noktaları temizle"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                  <input 
                    type="file" 
                    accept="*/*"
                    className="hidden" 
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                  />
                </div>

                {importedPoints.length > 0 && (
                  <div className={`${importSummary?.warnings.length ? 'bg-amber-500/10 border-amber-500/30' : 'bg-sky-500/10 border-sky-500/30'} border rounded-xl p-3 flex items-start gap-2`}>
                    <MapIcon className={`w-5 h-5 ${importSummary?.warnings.length ? 'text-amber-400' : 'text-sky-400'} shrink-0 mt-0.5`} />
                    <div>
                      <p className={`text-xs font-bold ${importSummary?.warnings.length ? 'text-amber-400' : 'text-sky-400'}`}>
                        Haritadan Seçim Yapın
                      </p>
                      <p className="text-[10px] text-slate-400 mt-1">
                        {importedPoints.length} nokta yüklendi
                        {importSummary ? ` | ${importSummary.coordinateMode}` : ''}. Stakeout yapmak istediğiniz noktaya harita üzerinden tıklayın.
                      </p>
                      {importSummary?.firstPoint && (
                        <p className="text-[10px] text-slate-500 mt-1 font-mono">
                          İlk: {importSummary.firstPoint.name} | Y {importSummary.firstPoint.lat.toFixed(3)} | X {importSummary.firstPoint.lon.toFixed(3)} | Z {importSummary.firstPoint.alt.toFixed(3)}
                        </p>
                      )}
                      {importSummary?.warnings.slice(0, 2).map((warning) => (
                        <p key={warning} className="text-[10px] text-amber-300 mt-1">
                          {warning}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              )}
            </div>
            )}

            {/* 3. HEDEF MESAFE */}
            {activeSection === 'target' && (
            <div className={`bg-slate-900/80 border ${guidanceReady ? 'border-emerald-500/50 ring-1 ring-emerald-500/30' : 'border-slate-800'} rounded-2xl p-3 sm:p-4 shadow-lg backdrop-blur-sm transition-all duration-300`}>
              <h2 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${guidanceReady ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-400'}`}>3</span>
                Hedef Mesafe veya Seçim
              </h2>
              <p className="text-[10px] text-slate-400 mb-3 leading-relaxed">
                Yarıçap aramak için mesafe girin. Stakeout için harita üzerinden nokta seçin — mesafe otomatik hedefe çevrilir.
              </p>

              <div className="space-y-3">
                {selectedNCNTarget && (
                  <div className="p-3 bg-sky-500/10 border border-sky-500/30 rounded-xl">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-sky-300 truncate">Hedef: {selectedNCNTarget.name}</span>
                      <span className="text-[10px] font-mono text-sky-200/70">Z {selectedNCNTarget.alt.toFixed(3)}</span>
                    </div>
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedNCNTarget(null);
                          setSlopeCorrectedTarget(null);
                          setTargetMode('DISTANCE');
                        }}
                        className="w-full py-2 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 text-[10px] font-bold"
                      >
                        Hedefi Temizle
                      </button>
                      <button
                        type="button"
                        onClick={() => setTargetMode('DISTANCE')}
                        className="hidden"
                        title="Mesafe moduna dön"
                        aria-label="Mesafe moduna dön"
                      >
                        <Ruler className="w-4 h-4 mx-auto" />
                      </button>
                    </div>
                  </div>
                )}
                <div className="relative">
                    <input
                      type="number"
                      step="0.01"
                      value={targetDistance}
                      onChange={(e) => setTargetDistance(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-2xl font-mono font-bold text-emerald-400 focus:outline-none focus:border-emerald-500 transition-all"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 font-bold text-sm">METRE</span>
                </div>

                {calibScale !== 1.0 && (
                  <div className="flex items-center justify-between bg-indigo-500/10 border border-indigo-500/30 p-3 rounded-xl mt-2">
                    <div className="flex items-center gap-2">
                      <Ruler className="w-4 h-4 text-indigo-400" />
                      <span className="text-xs font-bold text-indigo-300">Aktif Kalibrasyon</span>
                    </div>
                    <span className="text-xs font-mono text-indigo-400">x{calibScale.toFixed(4)}</span>
                  </div>
                )}
              </div>
            </div>
            )}
              </div>
            </aside>
          </div>
          )}

          {/* RIGHT PANEL: Guidance & Metrics (Fills remaining space) */}
          <div className="field-stage w-full lg:flex-1 flex flex-col gap-3 lg:gap-4 lg:min-h-0 order-first lg:order-last">
            
            {/* Main Map with Overlay */}
            <div className={`field-map-stage w-full h-[56dvh] sm:h-[60dvh] lg:h-auto lg:flex-1 min-h-[360px] relative overflow-hidden ${guidanceReady ? statusUI.bg : ''} transition-all duration-500`}>
              
              <div className="absolute inset-0 z-0">
                <MapView 
                  currentPoint={currentPoint} 
                  referencePoint={activeGuidancePoint} 
                  referenceLabel={pointStakeoutMode ? 'Aktif Hedef' : 'Baslangic P1'}
                  importedPoints={importedPoints} 
                  surfaceAdjustedPoints={surfaceAdjustedPoints}
                  showSurfaceLayer={showSurfaceLayer}
                  onToggleSurfaceLayer={setShowSurfaceLayer}
                  onSelectPoint={handleSelectPoint}
                />
              </div>

              <div className="field-map-status absolute top-3 left-3 z-[1000] pointer-events-none">
                <div className="field-hud-card max-w-[220px]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="field-hud-label">Baglanti</p>
                      <p className="field-hud-value truncate">{connectionTitle}</p>
                    </div>
                    <span className={`w-2.5 h-2.5 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-slate-500'}`} aria-hidden="true" />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="field-hud-chip">
                      <span className="field-hud-chip-label">FIX</span>
                      <strong style={{ color: currentFixInfo?.color || '#e2e8f0' }}>{currentFixInfo?.label || 'Bekleniyor'}</strong>
                    </div>
                    <div className="field-hud-chip">
                      <span className="field-hud-chip-label">MOD</span>
                      <strong>{pointStakeoutMode ? 'Nokta' : 'Mesafe'}</strong>
                    </div>
                  </div>
                </div>
              </div>

              <div className="field-map-target absolute left-3 right-20 bottom-3 sm:right-auto sm:max-w-[320px] z-[1000] pointer-events-none">
                <div className="field-hud-card">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="field-hud-label">{pointStakeoutMode ? 'Aktif Hedef' : 'Olcum Hedefi'}</p>
                      <p className="truncate text-sm font-bold text-white">{targetSummaryLabel}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="field-hud-label">{pointStakeoutMode ? 'Kalan' : 'Mesafe'}</p>
                      <p className="text-sm font-black text-cyan-200">
                        {liveDistanceDetail.val} <span className="text-[10px] text-cyan-100/60">{liveDistanceDetail.unit}</span>
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Vertical Distance Progress Bar */}
              {guidanceReady && !pointStakeoutMode && targetDistance > 0 && (
                <div className="field-range-bar absolute right-4 top-1/2 -translate-y-1/2 h-[80%] sm:h-[85%] w-10 sm:w-14 flex flex-col justify-end z-[1000] p-1 sm:p-1.5 pb-1 sm:pb-1 overflow-hidden pointer-events-none">
                  
                  {/* Indicator Line for Target (100%) */}
                  <div className="absolute top-[10%] left-0 right-0 h-1 sm:h-1.5 bg-stone-50 z-20 w-full rounded-full shadow-[0_0_12px_rgba(236,252,203,0.95)]"></div>
                  
                  {/* Target Distance Text */}
                  <div className="absolute top-[2%] w-full text-center left-0 text-[8px] sm:text-[9px] font-black text-stone-50/85 z-20 font-mono tracking-tighter drop-shadow-md">
                    HEDEF<br/>{targetDistance}m
                  </div>
                  
                  {/* The fill container */}
                  <div className="w-full flex-1 relative flex flex-col justify-end">
                    {/* The Fill Bar itself */}
                    <div 
                      className={`w-full rounded-full transition-all duration-300 ease-out flex items-start justify-center pt-3 sm:pt-4 ${
                        metrics.surface3dDistance >= targetDistance - 0.02 
                          ? 'bg-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.9)]' 
                          : 'bg-rose-500 shadow-[0_0_20px_rgba(244,63,94,0.9)]'
                      }`}
                      style={{ 
                        // 90% height means 100% of target distance. Leaves top 10% for overflow when exceeded.
                        height: `${Math.min(100, Math.max(5, (metrics.surface3dDistance / targetDistance) * 90))}%`
                      }}
                    >
                      {/* Vertical Error Text inside the bar */}
                      <div className="text-white text-[9px] sm:text-[10px] font-black tracking-tighter -rotate-90 origin-center whitespace-nowrap drop-shadow-md mt-6 sm:mt-8">
                        {metrics.surface3dDistance >= targetDistance - 0.02 ? `+${Math.max(0, metrics.surface3dDistance - targetDistance).toFixed(2)}m FAZLA` : `${Math.abs(metrics.error).toFixed(2)}m KALDI`}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Guidance Overlay Box */}
              {guidanceReady && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none w-[95%] sm:w-auto max-w-[420px]">
                  <div className={`field-guidance-pill flex items-center justify-center gap-3 sm:gap-4 px-3 sm:px-6 py-2.5 sm:py-4 ${statusUI.bg}`}>
                    <div className="shrink-0 scale-75 sm:scale-100">{statusUI.icon}</div>
                    <div className="flex flex-col items-start text-left min-w-0">
                      <h2 className={`text-sm sm:text-2xl lg:text-3xl font-black tracking-tight leading-none ${statusUI.color} truncate w-full`}>{statusUI.title}</h2>
                      <p className="text-[10px] sm:text-sm font-medium text-slate-300 mt-0.5 truncate">{statusUI.subtitle}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Metrics Grid (Fixed height at bottom) */}
            <div className="field-metrics grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4 shrink-0">
              {pointStakeoutMode ? (
                // ---------------- POINT STAKEOUT MODE ---------------- 
                <>
                  <div className="bg-slate-900/80 border border-slate-800 p-3 sm:p-4 rounded-2xl shadow-lg backdrop-blur-sm flex flex-col justify-center relative overflow-hidden">
                    <div className={`absolute inset-0 opacity-10 ${Math.abs(metrics.plane2dDistance) <= 0.02 ? 'bg-emerald-500' : 'bg-amber-500'}`}></div>
                    <p className="text-[9px] sm:text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1 relative z-10 truncate">KALAN MESAFE</p>
                    <p className={`text-xl sm:text-3xl font-mono font-bold flex items-baseline gap-1 relative z-10 ${Math.abs(metrics.plane2dDistance) <= 0.02 ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {formatDistanceDetail(metrics.plane2dDistance).val} <span className="text-[10px] sm:text-xs text-slate-500">{formatDistanceDetail(metrics.plane2dDistance).unit}</span>
                    </p>
                  </div>
                  
                  <div className="bg-slate-900/80 border border-slate-800 p-3 sm:p-4 rounded-2xl shadow-lg backdrop-blur-sm flex flex-col justify-center relative">
                    <p className="text-[9px] sm:text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1 truncate">K/G (Y)</p>
                    <p className="text-lg sm:text-2xl font-mono font-bold text-white flex items-baseline gap-1 truncate">
                      <span className="shrink-0">{metrics.deltaNorth >= 0 ? "↑ K" : "↓ G"}</span> {formatDistanceDetail(Math.abs(metrics.deltaNorth)).val} <span className="text-[10px] sm:text-xs text-slate-500">{formatDistanceDetail(Math.abs(metrics.deltaNorth)).unit}</span>
                    </p>
                  </div>

                  <div className="bg-slate-900/80 border border-slate-800 p-3 sm:p-4 rounded-2xl shadow-lg backdrop-blur-sm flex flex-col justify-center relative">
                    <p className="text-[9px] sm:text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1 truncate">D/B (X)</p>
                    <p className="text-lg sm:text-2xl font-mono font-bold text-white flex items-baseline gap-1 truncate">
                       <span className="shrink-0">{metrics.deltaEast >= 0 ? "→ D" : "← B"}</span> {formatDistanceDetail(Math.abs(metrics.deltaEast)).val} <span className="text-[10px] sm:text-xs text-slate-500">{formatDistanceDetail(Math.abs(metrics.deltaEast)).unit}</span>
                    </p>
                  </div>

                  <div className="bg-slate-900/80 border border-emerald-500/30 p-3 sm:p-4 rounded-2xl shadow-lg backdrop-blur-sm flex flex-col justify-center">
                    <p className="text-[9px] sm:text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1 truncate">YUZEY MESAFE (3D)</p>
                    <p className="text-lg sm:text-2xl font-mono font-bold text-emerald-400 flex items-baseline gap-1 truncate">
                      {formatDistanceDetail(metrics.surface3dDistance).val} <span className="text-[10px] sm:text-xs opacity-60">{formatDistanceDetail(metrics.surface3dDistance).unit}</span>
                    </p>
                  </div>
                </>
              ) : (
                // ---------------- RADIAL DISTANCE MODE ----------------
                <>
                  <div className="bg-slate-900/80 border border-slate-800 p-3 sm:p-4 rounded-2xl shadow-lg backdrop-blur-sm flex flex-col justify-center">
                    <p className="text-[9px] sm:text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1 truncate">Yuzey Mesafe (3D)</p>
                    <p className="text-xl sm:text-3xl font-mono font-bold text-white flex items-baseline gap-1">
                      {formatDistanceDetail(metrics.surface3dDistance).val} <span className="text-[10px] sm:text-xs text-slate-500">{formatDistanceDetail(metrics.surface3dDistance).unit}</span>
                    </p>
                  </div>
                  
                  <div className="bg-slate-900/80 border border-slate-800 p-3 sm:p-4 rounded-2xl shadow-lg backdrop-blur-sm flex flex-col justify-center relative overflow-hidden">
                    <div className={`absolute inset-0 opacity-10 ${Math.abs(metrics.error) <= 0.02 ? 'bg-emerald-500' : 'bg-rose-500'}`}></div>
                    <p className="text-[9px] sm:text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1 relative z-10 truncate">Hata Payı</p>
                    <p className={`text-xl sm:text-3xl font-mono font-bold relative z-10 flex items-baseline gap-1 ${Math.abs(metrics.error) <= 0.02 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {formatDistanceDetail(metrics.error, true).val} <span className="text-[10px] sm:text-xs opacity-50">{formatDistanceDetail(metrics.error).unit}</span>
                    </p>
                  </div>

                  <div className="bg-slate-900/80 border border-slate-800 p-3 sm:p-4 rounded-2xl shadow-lg backdrop-blur-sm flex flex-col justify-center">
                    <p className="text-[9px] sm:text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1 truncate">Duzlem Mesafe (2D)</p>
                    <p className="text-lg sm:text-2xl font-mono font-semibold text-slate-300 flex items-baseline gap-1">
                      {formatDistanceDetail(metrics.plane2dDistance).val} <span className="text-[10px] sm:text-xs text-slate-500">{formatDistanceDetail(metrics.plane2dDistance).unit}</span>
                    </p>
                  </div>

                  <div className={`bg-slate-900/80 border p-3 sm:p-4 rounded-2xl shadow-lg backdrop-blur-sm flex flex-col justify-center ${metrics.elevationDifference > 0 ? 'border-sky-500/30' : 'border-slate-800'}`}>
                    <p className="text-[9px] sm:text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1 truncate">KOT FARKI (Z)</p>
                    <p className="text-lg sm:text-2xl font-mono font-semibold text-slate-300 flex items-baseline gap-1">
                      {formatDistanceDetail(metrics.elevationDifference, true).val} <span className="text-[10px] sm:text-xs text-slate-500">{formatDistanceDetail(metrics.elevationDifference).unit}</span>
                    </p>
                  </div>
                </>
              )}
            </div>

            <div className="sm:hidden -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 scrollbar-hide">
              <div className="field-mobile-debug-card">
                <span className="field-mobile-pill-label">QUALITY</span>
                <strong className={metrics.qualityOk ? 'text-emerald-300' : 'text-amber-300'}>{ACCURACY_MODE_LABELS[metrics.qualityMode]}</strong>
                <p className="truncate text-[11px] text-slate-400">{metrics.qualityReason}</p>
              </div>
              <div className="field-mobile-debug-card">
                <span className="field-mobile-pill-label">P1</span>
                <strong className="text-white">{referencePoint ? 'Hazir' : 'Bekleniyor'}</strong>
                <p className="truncate text-[11px] text-slate-400">{referencePoint ? `${referencePoint.lat.toFixed(5)}, ${referencePoint.lon.toFixed(5)}` : 'Referans secilmedi'}</p>
              </div>
              <div className="field-mobile-debug-card">
                <span className="field-mobile-pill-label">SURFACE</span>
                <strong className={metrics.surfaceCorrected ? 'text-cyan-200' : 'text-slate-300'}>{metrics.surfaceCorrected ? `${metrics.slopeDeg.toFixed(1)} deg` : 'Pasif'}</strong>
                <p className="truncate text-[11px] text-slate-400">{metrics.surfaceCorrected ? `${metrics.surfacePointsUsed} nokta | RMS ${(metrics.residualRMS * 1000).toFixed(0)} mm` : 'En az 3 nokta gerekli'}</p>
              </div>
            </div>

            {/* Debug Info Footer */}
            <div className="field-debug-strip hidden sm:flex rounded-xl p-3 text-[10px] sm:text-xs font-mono text-stone-400 flex-col sm:flex-row sm:justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis">
                <span className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-400 font-bold">QUALITY</span>
                <span className={`${metrics.qualityOk ? 'text-emerald-400' : 'text-amber-400'} truncate`}>
                  {ACCURACY_MODE_LABELS[metrics.qualityMode]} | {metrics.qualityReason}
                </span>
              </div>
              <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis">
                <span className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-400 font-bold">P1 (REF)</span>
                <span className="text-slate-400 truncate">
                  {referencePoint ? `${referencePoint.lat.toFixed(6)}, ${referencePoint.lon.toFixed(6)} | Z: ${referencePoint.alt.toFixed(2)}` : 'Ayarlanmadı'}
                </span>
              </div>
              <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis">
                <span className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-400 font-bold">GNSS (CUR)</span>
                <span className="text-slate-400 truncate">
                  {currentPoint ? `${currentPoint.lat.toFixed(6)}, ${currentPoint.lon.toFixed(6)} | Z: ${currentPoint.alt.toFixed(2)}` : 'Veri bekleniyor...'}
                </span>
              </div>
              <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis">
                <span className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-400 font-bold">SURFACE</span>
                <span className={`${
                  metrics.surfaceCorrected
                    ? metrics.residualRMS > 0.5 ? 'text-amber-400' : 'text-emerald-400'
                    : 'text-slate-500'
                } truncate`}>
                  {metrics.surfaceCorrected
                    ? `Aktif (${String(metrics.surfaceSource).toUpperCase()}) | Egim: ${metrics.slopeDeg.toFixed(2)} deg / Az: ${metrics.slopeAzimuthDeg.toFixed(0)} deg | ${metrics.surfacePointsUsed} nokta | RMS: ${(metrics.residualRMS * 1000).toFixed(0)}mm | C: ${(metrics.surfaceConfidence * 100).toFixed(0)}%`
                    : 'Pasif (en az 3 import nokta gerekir)'}
                </span>
                {surfaceReport.candidates.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowSurfaceRationale(v => !v)}
                    className="ml-auto px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 hover:bg-slate-700 text-[10px]"
                    title="Aday duzlem skorlari"
                  >
                    {showSurfaceRationale ? 'Gizle' : 'Nicin?'}
                  </button>
                )}
              </div>
              {showSurfaceRationale && surfaceReport.candidates.length > 0 && (
                <div className="ml-2 mt-1 p-2 rounded bg-slate-900/70 border border-slate-800 text-[11px] leading-tight space-y-1">
                  {surfaceReport.candidates.map((c) => (
                    <div key={c.source} className="flex items-start gap-2">
                      <span className={`px-1 py-0.5 rounded text-[10px] font-bold ${
                        c.accepted ? 'bg-emerald-900/60 text-emerald-300' : 'bg-slate-800 text-slate-500'
                      }`}>
                        {c.source.toUpperCase()}
                      </span>
                      <span className="text-slate-400">
                        {c.pointsUsed} nokta | yayilim {c.extentMeters.toFixed(1)}m
                        {c.accepted
                          ? ` | RMS ${(c.residualRMS * 1000).toFixed(0)}mm | C ${(c.confidence * 100).toFixed(0)}% (rms ${(c.rmsScore * 100).toFixed(0)}/pts ${(c.pointsScore * 100).toFixed(0)}/slp ${(c.slopeScore * 100).toFixed(0)})`
                          : ` | reddedildi: ${c.rejectionReason || 'bilinmiyor'}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {/* RTK Fix Kalitesi */}
              {currentPoint && (() => {
                const fix = displayFixLabel((currentPoint as any).fix ?? 1, connectionType);
                return (
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-400 font-bold">FIX</span>
                    <span className="font-bold" style={{ color: fix.color }}>{fix.label}</span>
                    {(currentPoint as any).hdop !== undefined && (
                      <span className="text-slate-500">HDOP: {(currentPoint as any).hdop?.toFixed(1)}</span>
                    )}
                  </div>
                );
              })()}
            </div>

          </div>
        </div>
      </main>

      <div className="field-mobile-nav sm:hidden">
        <div className="field-mobile-nav-inner safe-bottom">
          {sectionActions.map(({ key, icon: Icon, label, accent, dot }) => {
            const active = activeSection === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActiveSection(prev => (prev === key ? null : key))}
                className={`field-mobile-nav-button ${getSectionTone(active, accent)}`}
                aria-label={label}
                aria-pressed={active}
              >
                <span className="relative flex items-center justify-center">
                  <Icon className="w-4 h-4" />
                  <span className={`absolute -top-1.5 -right-1.5 w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden="true" />
                </span>
                <span className="mt-1 text-[10px] font-semibold">{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* --- NOTIFICATION TOAST --- */}
      {notification && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[60] animate-in fade-in slide-in-from-top-5 duration-300 px-3 w-full max-w-md"
          style={{ top: 'calc(env(safe-area-inset-top) + 4.5rem)' }}
        >
          <div className={`px-4 py-3 rounded-xl shadow-2xl border flex items-center gap-3 w-full ${
            notification.type === 'success' ? 'bg-emerald-900/90 border-emerald-500/50 text-emerald-100' :
            notification.type === 'error' ? 'bg-rose-900/90 border-rose-500/50 text-rose-100' :
            'bg-sky-900/90 border-sky-500/50 text-sky-100'
          }`}>
            {notification.type === 'success' ? <CheckCircle className="w-5 h-5 shrink-0" /> :
             notification.type === 'error' ? <X className="w-5 h-5 shrink-0" /> :
             <Activity className="w-5 h-5 shrink-0" />}
            <p className="text-sm font-medium leading-tight">{notification.message}</p>
          </div>
        </div>
      )}

      {/* --- JALON YÜKSEKLIK UYARI MODALI --- */}
      {showPoleWarning && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 w-full max-w-sm rounded-2xl shadow-2xl border border-amber-500/30 overflow-hidden">
            <div className="p-5">
              <p className="text-amber-400 font-bold text-base">⚠ Jalon Yüksekliği Değişti</p>
              <p className="text-slate-300 text-sm mt-2">
                P1 referans noktası eski yükseklikle alındı. Ölçüm hatalarını önlemek için P1'i yeniden alın.
              </p>
            </div>
            <div className="flex border-t border-slate-700">
              <button
                onClick={() => { setReferencePoint(null); setShowPoleWarning(false); }}
                className="flex-1 py-3 text-sm font-bold text-rose-400 hover:bg-rose-500/10 transition-colors"
              >
                P1'i Temizle
              </button>
              <div className="w-px bg-slate-700" />
              <button
                onClick={() => setShowPoleWarning(false)}
                className="flex-1 py-3 text-sm font-bold text-slate-400 hover:bg-slate-800 transition-colors"
              >
                Yok Say
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- CALIBRATION MODAL --- */}
      {showCalibration && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4 safe-bottom">
          <div className="bg-slate-900 w-full max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col border border-slate-700 overflow-hidden max-h-[92dvh]">
            <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-900/50">
              <div className="flex items-center gap-3 text-white">
                <div className="p-2 bg-indigo-500/10 rounded-lg border border-indigo-500/20">
                  <Ruler className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <h3 className="font-bold">Cihaz Kalibrasyonu</h3>
                  <p className="text-[10px] text-slate-400">GNSS sapmalarını ölçerek düzeltin</p>
                </div>
              </div>
              <button
                onClick={() => setShowCalibration(false)}
                className="touch-target p-2 text-slate-400 hover:text-white hover:bg-slate-800 active:bg-slate-700 rounded-xl transition-colors flex items-center justify-center"
                aria-label="Kalibrasyonu Kapat"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <div className="p-5 space-y-5 overflow-y-auto">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Bilinen Gerçek Mesafe (Örn: İki Kasa Arası)</label>
                <div className="relative">
                  <input 
                    type="number" 
                    step="0.01"
                    value={calibKnownDistance}
                    onChange={(e) => setCalibKnownDistance(parseFloat(e.target.value) || 0)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-2xl font-mono font-bold text-indigo-400 focus:outline-none focus:border-indigo-500"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 font-bold text-sm">METRE</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button 
                  onClick={() => captureCalibrationPoint('A')}
                  className={`p-4 rounded-xl border flex flex-col items-center justify-center gap-2 transition-all ${calibPtA ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}
                >
                  <MapPin className="w-6 h-6" />
                  <span className="text-xs font-bold">1. NOKTAYI OKU</span>
                  {calibPtA && <span className="text-[10px] bg-emerald-500/20 px-2 py-0.5 rounded">HAYIRLI OLSUN</span>}
                </button>
                
                <button 
                  onClick={() => captureCalibrationPoint('B')}
                  className={`p-4 rounded-xl border flex flex-col items-center justify-center gap-2 transition-all ${calibPtB ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}
                >
                  <MapPin className="w-6 h-6" />
                  <span className="text-xs font-bold">2. NOKTAYI OKU</span>
                  {calibPtB && <span className="text-[10px] bg-emerald-500/20 px-2 py-0.5 rounded">HAYIRLI OLSUN</span>}
                </button>
              </div>

              {calibPtA && calibPtB && (
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 flex justify-between items-center">
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase font-bold">Ölçülen (Cihaz)</p>
                    <p className="text-lg font-mono font-bold text-slate-300">
                      {calculateDistance(calibPtA.lat, calibPtA.lon, calibPtA.alt, calibPtB.lat, calibPtB.lon, calibPtB.alt).realDistance.toFixed(3)} m
                    </p>
                  </div>
                  <ArrowUp className="w-5 h-5 text-indigo-400 rotate-90" />
                  <div className="text-right">
                    <p className="text-[10px] text-slate-500 uppercase font-bold">Yeni Çarpan</p>
                    <p className="text-lg font-mono font-bold text-indigo-400">
                      {(calibKnownDistance / calculateDistance(calibPtA.lat, calibPtA.lon, calibPtA.alt, calibPtB.lat, calibPtB.lon, calibPtB.alt).realDistance).toFixed(4)}x
                    </p>
                  </div>
                </div>
              )}

              <button 
                onClick={handleApplyCalibration}
                disabled={!calibPtA || !calibPtB}
                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-4 rounded-xl shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Kalibrasyonu Uygula ve Kaydet
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- LOGS MODAL --- */}
      {showLogs && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4 safe-bottom">
          <div className="bg-slate-900 w-full sm:max-w-3xl h-[90dvh] sm:h-[600px] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col border border-slate-700 overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-900/50">
              <div className="flex items-center gap-3 text-white">
                <div className="p-2 bg-sky-500/10 rounded-lg border border-sky-500/20">
                  <Terminal className="w-5 h-5 text-sky-400" />
                </div>
                <div>
                  <h3 className="font-bold">Sistem Logları</h3>
                  <p className="text-xs text-slate-400">{logs.length} kayıt bulundu</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleExportCSV}
                  className="flex items-center gap-2 px-3 py-2 bg-emerald-900/40 hover:bg-emerald-800/50 text-emerald-300 text-xs font-bold rounded-xl transition-colors border border-emerald-700/50"
                  title="Ölçümleri CSV olarak indir"
                >
                  <Download className="w-4 h-4" /> <span className="hidden sm:inline">CSV</span>
                </button>
                <button
                  onClick={handleExportLogs}
                  className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded-xl transition-colors border border-slate-700"
                >
                  <Download className="w-4 h-4" /> <span className="hidden sm:inline">Dışa Aktar</span>
                </button>
                <button
                  onClick={() => setLogs([])}
                  className="touch-target p-2 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 active:bg-rose-500/20 rounded-xl transition-colors flex items-center justify-center"
                  title="Logları Temizle"
                  aria-label="Logları Temizle"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
                <div className="w-px h-6 bg-slate-800 mx-1"></div>
                <button
                  onClick={() => setShowLogs(false)}
                  className="touch-target p-2 text-slate-400 hover:text-white hover:bg-slate-800 active:bg-slate-700 rounded-xl transition-colors flex items-center justify-center"
                  aria-label="Logları Kapat"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 bg-[#0A0D14] font-mono text-xs space-y-2">
              {logs.length === 0 ? (
                <div className="text-slate-600 text-center mt-20 flex flex-col items-center">
                  <Activity className="w-8 h-8 mb-3 opacity-20" />
                  <p>Henüz log kaydı bulunmuyor.</p>
                </div>
              ) : (
                logs.map(log => (
                  <div key={log.id} className="border-b border-slate-800/50 pb-2 mb-2 last:border-0 hover:bg-slate-800/20 p-2 rounded transition-colors">
                    <div className="flex items-start gap-3">
                      <span className="text-slate-500 shrink-0">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span className={`shrink-0 font-bold w-12 ${
                        log.type === 'NMEA' ? 'text-emerald-400' :
                        log.type === 'WARN' ? 'text-amber-400' :
                        log.type === 'CALC' ? 'text-purple-400' :
                        log.type === 'API' ? 'text-sky-400' :
                        log.type === 'ERROR' ? 'text-rose-400' :
                        'text-slate-400'
                      }`}>
                        {log.type}
                      </span>
                      <span className="text-slate-300 break-words">{log.message}</span>
                    </div>
                    {log.details && (
                      <div className="mt-2 ml-[100px] text-slate-400 break-all bg-slate-900/80 border border-slate-800 p-3 rounded-lg">
                        {log.details}
                      </div>
                    )}
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
