import localforage from 'localforage';
import type { ImportedPoint } from './ncnParser';
import type { NMEAData } from './nmea';
import type { AccuracyMode } from './quality';

localforage.config({
  name: 'slopefix-rtk',
  storeName: 'session_state',
  description: 'SlopeFix RTK saha oturumu — proje noktalari, referans, ayarlar.',
});

const KEY_VERSION = 'state.version';
const KEY_IMPORTED_POINTS = 'state.importedPoints';
const KEY_REFERENCE_POINT = 'state.referencePoint';
const KEY_CALIB_SCALE = 'state.calibScale';
const KEY_ACCURACY_MODE = 'state.accuracyMode';
const KEY_POLE_HEIGHT = 'state.poleHeight';
const KEY_TARGET_DISTANCE = 'state.targetDistance';
const KEY_RTK_CONFIG = 'state.rtkConfig';

const SCHEMA_VERSION = 1;

export interface RtkConfigSnapshot {
  host: string;
  port: string;
  mountPoint: string;
  username: string;
  password: string;
  useTls: boolean;
}

export interface PersistedState {
  importedPoints: ImportedPoint[];
  referencePoint: NMEAData | null;
  calibScale: number;
  accuracyMode: AccuracyMode;
  poleHeight: number;
  targetDistance: number;
  rtkConfig: RtkConfigSnapshot;
}

async function getItem<T>(key: string, fallback: T): Promise<T> {
  try {
    const value = await localforage.getItem<T>(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

export async function loadPersistedState(defaults: PersistedState): Promise<PersistedState> {
  try {
    const version = await localforage.getItem<number>(KEY_VERSION);
    if (version !== null && version !== SCHEMA_VERSION) {
      await localforage.clear();
      await localforage.setItem(KEY_VERSION, SCHEMA_VERSION);
      return defaults;
    }
    if (version === null) {
      await localforage.setItem(KEY_VERSION, SCHEMA_VERSION);
    }
  } catch {
    return defaults;
  }

  const [importedPoints, referencePoint, calibScale, accuracyMode, poleHeight, targetDistance, rtkConfig] =
    await Promise.all([
      getItem<ImportedPoint[]>(KEY_IMPORTED_POINTS, defaults.importedPoints),
      getItem<NMEAData | null>(KEY_REFERENCE_POINT, defaults.referencePoint),
      getItem<number>(KEY_CALIB_SCALE, defaults.calibScale),
      getItem<AccuracyMode>(KEY_ACCURACY_MODE, defaults.accuracyMode),
      getItem<number>(KEY_POLE_HEIGHT, defaults.poleHeight),
      getItem<number>(KEY_TARGET_DISTANCE, defaults.targetDistance),
      getItem<RtkConfigSnapshot>(KEY_RTK_CONFIG, defaults.rtkConfig),
    ]);

  return {
    importedPoints,
    referencePoint,
    calibScale,
    accuracyMode,
    poleHeight,
    targetDistance,
    rtkConfig: {
      ...rtkConfig,
      password: '',
    },
  };
}

async function setItem<T>(key: string, value: T): Promise<void> {
  try {
    await localforage.setItem(key, value);
  } catch {
    // Kota dolmus ya da private mode — sessizce atla
  }
}

export const persist = {
  importedPoints: (value: ImportedPoint[]) => setItem(KEY_IMPORTED_POINTS, value),
  referencePoint: (value: NMEAData | null) => setItem(KEY_REFERENCE_POINT, value),
  calibScale: (value: number) => setItem(KEY_CALIB_SCALE, value),
  accuracyMode: (value: AccuracyMode) => setItem(KEY_ACCURACY_MODE, value),
  poleHeight: (value: number) => setItem(KEY_POLE_HEIGHT, value),
  targetDistance: (value: number) => setItem(KEY_TARGET_DISTANCE, value),
  rtkConfig: (value: RtkConfigSnapshot) => setItem(KEY_RTK_CONFIG, { ...value, password: '' }),
  clearAll: async () => {
    try { await localforage.clear(); } catch { /* noop */ }
  },
};
