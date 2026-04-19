import type { NMEAData } from './nmea';

export type RtkStatus = 'OFF' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'FLOAT' | 'FIXED' | 'ERROR';

export type DeviceConnectionType = 'none' | 'android-bt-spp' | 'web-serial' | 'phone-gps';

export type GnssSample = NMEAData & {
  rawGga?: string;
  timestamp: number;
};

export type CorrectionProfile = {
  name: string;
  host: string;
  port: number;
  mountPoint: string;
  username?: string;
  password?: string;
  useTls: boolean;
  sendGgaIntervalMs: number;
};

export type DeviceConnection = {
  type: DeviceConnectionType;
  status: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';
  deviceName?: string;
  deviceAddress?: string;
  message?: string;
};

export type RtkTelemetry = {
  status: RtkStatus;
  message: string;
  bytesTotal: number;
  bytesPerSecond: number;
  lastGgaAt: number | null;
  lastRtcmAt: number | null;
  fixedSince: number | null;
};

export const TUSAGA_CORRECTION_PROFILE: CorrectionProfile = {
  name: 'TUSAGA-Aktif',
  host: '212.156.70.42',
  port: 2101,
  mountPoint: 'VRSRTCM3.1',
  username: '',
  password: '',
  useTls: false,
  sendGgaIntervalMs: 5000,
};

export const TUSAGA_MOUNTPOINTS = ['VRSRTCM3.1', 'VRSCMRP', 'RTCM3Net', 'FKP_RTCM31', 'DGPSNet'] as const;

export function normalizeCorrectionProfile(profile: Partial<CorrectionProfile>): CorrectionProfile {
  return {
    ...TUSAGA_CORRECTION_PROFILE,
    ...profile,
    name: (profile.name || TUSAGA_CORRECTION_PROFILE.name).trim(),
    host: (profile.host || '').trim(),
    port: Number(profile.port || TUSAGA_CORRECTION_PROFILE.port),
    mountPoint: (profile.mountPoint || '').trim().replace(/^\/+/, ''),
    username: profile.username || '',
    password: profile.password || '',
    useTls: Boolean(profile.useTls),
    sendGgaIntervalMs: Math.max(1000, Number(profile.sendGgaIntervalMs || TUSAGA_CORRECTION_PROFILE.sendGgaIntervalMs)),
  };
}

export function validateCorrectionProfile(profile: Partial<CorrectionProfile>): string | null {
  const normalized = normalizeCorrectionProfile(profile);

  if (!normalized.host) return 'NTRIP host zorunlu.';
  if (!/^[a-z0-9.-]+$/i.test(normalized.host) || normalized.host.length > 253) return 'NTRIP host gecersiz.';
  if (!Number.isInteger(normalized.port) || normalized.port <= 0 || normalized.port > 65535) return 'NTRIP port gecersiz.';
  if (!normalized.mountPoint) return 'NTRIP mountpoint zorunlu.';
  if (normalized.mountPoint.length > 128 || /\s/.test(normalized.mountPoint)) return 'NTRIP mountpoint gecersiz.';
  if (!Number.isFinite(normalized.sendGgaIntervalMs) || normalized.sendGgaIntervalMs < 1000) return 'GGA araligi gecersiz.';

  return null;
}

export function rtcmBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function rtcmBase64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function applyPoleHeightToPoint(point: NMEAData, poleHeight: number): NMEAData {
  const height = Number.isFinite(poleHeight) ? Math.max(0, poleHeight) : 0;
  if (height <= 0) return point;

  return {
    ...point,
    antennaAlt: point.antennaAlt ?? point.alt,
    antennaMslAlt: point.antennaMslAlt ?? point.mslAlt,
    poleHeight: height,
    alt: (point.antennaAlt ?? point.alt) - height,
    mslAlt: (point.antennaMslAlt ?? point.mslAlt) - height,
  };
}

export function getFixDerivedRtkStatus(point: Pick<NMEAData, 'fix'> | null, fallback: RtkStatus): RtkStatus {
  if (!point) return fallback;
  if (point.fix === 4) return 'FIXED';
  if (point.fix === 5) return 'FLOAT';
  return fallback;
}
