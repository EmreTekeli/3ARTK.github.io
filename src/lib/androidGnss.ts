import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { CorrectionProfile, DeviceConnection } from './rtk';

export type AndroidBluetoothDevice = {
  name: string;
  address: string;
};

type ListenerCleanup = () => void;

type SlopeFixGnssPlugin = {
  listBluetoothDevices(): Promise<{ devices: AndroidBluetoothDevice[] }>;
  connectBluetooth(options: { address: string }): Promise<DeviceConnection>;
  disconnectDevice(): Promise<DeviceConnection>;
  startNtrip(options: CorrectionProfile & { gga?: string }): Promise<{ status: string }>;
  stopNtrip(): Promise<void>;
  sendGga(options: { gga: string }): Promise<void>;
  writeRtcm(options: { data: string }): Promise<void>;
  addListener(eventName: 'nmea', listenerFunc: (payload: { line: string; timestamp: number }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'deviceStatus', listenerFunc: (payload: DeviceConnection) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'rtkStatus', listenerFunc: (payload: { status: string; message?: string; code?: string; timestamp?: number }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'rtcmWritten', listenerFunc: (payload: { bytes: number; timestamp: number }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'ggaSent', listenerFunc: (payload: { sentAt: number }) => void): Promise<PluginListenerHandle>;
};

export const SlopeFixGnss = registerPlugin<SlopeFixGnssPlugin>('SlopeFixGnss');

export function isNativeAndroidGnss(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function addAndroidGnssListeners(listeners: {
  onNmea?: (line: string, timestamp: number) => void;
  onDeviceStatus?: (status: DeviceConnection) => void;
  onRtkStatus?: (status: { status: string; message?: string; code?: string; timestamp?: number }) => void;
  onRtcmWritten?: (bytes: number, timestamp: number) => void;
  onGgaSent?: (sentAt: number) => void;
}): Promise<ListenerCleanup> {
  const handles: PluginListenerHandle[] = [];

  if (listeners.onNmea) {
    handles.push(await SlopeFixGnss.addListener('nmea', payload => listeners.onNmea?.(payload.line, payload.timestamp)));
  }
  if (listeners.onDeviceStatus) {
    handles.push(await SlopeFixGnss.addListener('deviceStatus', payload => listeners.onDeviceStatus?.(payload)));
  }
  if (listeners.onRtkStatus) {
    handles.push(await SlopeFixGnss.addListener('rtkStatus', payload => listeners.onRtkStatus?.(payload)));
  }
  if (listeners.onRtcmWritten) {
    handles.push(await SlopeFixGnss.addListener('rtcmWritten', payload => listeners.onRtcmWritten?.(payload.bytes, payload.timestamp)));
  }
  if (listeners.onGgaSent) {
    handles.push(await SlopeFixGnss.addListener('ggaSent', payload => listeners.onGgaSent?.(payload.sentAt)));
  }

  return () => {
    handles.forEach(handle => {
      void handle.remove();
    });
  };
}
