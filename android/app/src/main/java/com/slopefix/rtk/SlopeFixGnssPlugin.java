package com.slopefix.rtk;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLSocketFactory;

@CapacitorPlugin(
  name = "SlopeFixGnss",
  permissions = {
    @Permission(
      alias = "bluetooth",
      strings = {
        Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.BLUETOOTH_SCAN
      }
    )
  }
)
public class SlopeFixGnssPlugin extends Plugin {
  private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

  private final ExecutorService ioExecutor = Executors.newCachedThreadPool();
  private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

  private BluetoothSocket bluetoothSocket;
  private InputStream bluetoothInput;
  private OutputStream bluetoothOutput;
  private volatile boolean deviceReaderRunning = false;

  private Socket ntripSocket;
  private OutputStream ntripOutput;
  private volatile boolean ntripRunning = false;
  private volatile String latestGga = "";
  private ScheduledFuture<?> ggaFuture;

  @PluginMethod
  public void listBluetoothDevices(PluginCall call) {
    if (!ensureBluetoothPermission(call, "listBluetoothDevicesPerms")) return;

    try {
      BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
      if (adapter == null) {
        call.reject("Bluetooth adapter bulunamadi.", "NO_BLUETOOTH_ADAPTER");
        return;
      }

      JSArray devices = new JSArray();
      Set<BluetoothDevice> bondedDevices = adapter.getBondedDevices();
      for (BluetoothDevice device : bondedDevices) {
        JSObject item = new JSObject();
        item.put("name", device.getName() == null ? "Isimsiz cihaz" : device.getName());
        item.put("address", device.getAddress());
        devices.put(item);
      }

      JSObject result = new JSObject();
      result.put("devices", devices);
      call.resolve(result);
    } catch (SecurityException error) {
      call.reject("Bluetooth izni reddedildi.", "BLUETOOTH_PERMISSION_DENIED", error);
    }
  }

  @PluginMethod
  public void connectBluetooth(PluginCall call) {
    if (!ensureBluetoothPermission(call, "connectBluetoothPerms")) return;

    String address = call.getString("address", "");
    if (address.trim().isEmpty()) {
      call.reject("Bluetooth cihaz adresi zorunlu.", "DEVICE_ADDRESS_REQUIRED");
      return;
    }

    ioExecutor.execute(() -> {
      try {
        closeBluetooth();

        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) {
          call.reject("Bluetooth adapter bulunamadi.", "NO_BLUETOOTH_ADAPTER");
          return;
        }

        BluetoothDevice device = adapter.getRemoteDevice(address);
        BluetoothSocket socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
        adapter.cancelDiscovery();
        socket.connect();

        bluetoothSocket = socket;
        bluetoothInput = new BufferedInputStream(socket.getInputStream());
        bluetoothOutput = new BufferedOutputStream(socket.getOutputStream());
        deviceReaderRunning = true;

        JSObject status = new JSObject();
        status.put("status", "CONNECTED");
        status.put("type", "android-bt-spp");
        status.put("deviceName", device.getName());
        status.put("deviceAddress", device.getAddress());
        notifyListeners("deviceStatus", status, true);

        call.resolve(status);
        startBluetoothReader();
      } catch (SecurityException error) {
        call.reject("Bluetooth izni reddedildi.", "BLUETOOTH_PERMISSION_DENIED", error);
      } catch (IOException error) {
        closeBluetooth();
        call.reject("Bluetooth SPP baglantisi acilamadi: " + error.getMessage(), "BLUETOOTH_CONNECT_FAILED", error);
      } catch (IllegalArgumentException error) {
        call.reject("Bluetooth cihaz adresi gecersiz.", "DEVICE_ADDRESS_INVALID", error);
      }
    });
  }

  @PluginMethod
  public void disconnectDevice(PluginCall call) {
    stopNtripInternal();
    closeBluetooth();
    JSObject status = new JSObject();
    status.put("status", "DISCONNECTED");
    status.put("type", "android-bt-spp");
    notifyListeners("deviceStatus", status, true);
    call.resolve(status);
  }

  @PluginMethod
  public void startNtrip(PluginCall call) {
    String host = call.getString("host", "").trim();
    String mountPoint = call.getString("mountPoint", "").trim();
    int port = call.getInt("port", call.getBoolean("useTls", false) ? 443 : 2101);
    String username = call.getString("username", "");
    String password = call.getString("password", "");
    boolean useTls = call.getBoolean("useTls", false);
    int ggaIntervalMs = call.getInt("sendGgaIntervalMs", 5000);
    String initialGga = call.getString("gga", "");

    if (host.isEmpty() || mountPoint.isEmpty()) {
      call.reject("NTRIP host ve mountpoint zorunlu.", "NTRIP_CONFIG_REQUIRED");
      return;
    }

    if (bluetoothOutput == null) {
      call.reject("RTCM yazmak icin once Bluetooth SPP cihazi baglayin.", "DEVICE_NOT_CONNECTED");
      return;
    }

    latestGga = initialGga == null ? latestGga : initialGga.trim();
    stopNtripInternal();

    ioExecutor.execute(() -> {
      try {
        ntripRunning = true;
        emitRtkStatus("CONNECTING", "NTRIP baglantisi baslatiliyor.");

        Socket socket = useTls
          ? SSLSocketFactory.getDefault().createSocket(host, port)
          : new Socket(host, port);
        socket.setSoTimeout(30000);
        socket.setTcpNoDelay(true);

        ntripSocket = socket;
        InputStream input = new BufferedInputStream(socket.getInputStream());
        ntripOutput = new BufferedOutputStream(socket.getOutputStream());

        String cleanMount = mountPoint.replaceFirst("^/+", "");
        StringBuilder request = new StringBuilder();
        request.append("GET /").append(cleanMount).append(" HTTP/1.1\r\n");
        request.append("Host: ").append(host).append(":").append(port).append("\r\n");
        request.append("Ntrip-Version: Ntrip/2.0\r\n");
        request.append("User-Agent: NTRIP SlopeFixRTK-Android/1.0\r\n");
        if (!username.isEmpty() || !password.isEmpty()) {
          String token = Base64.encodeToString((username + ":" + password).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
          request.append("Authorization: Basic ").append(token).append("\r\n");
        }
        request.append("Connection: close\r\n\r\n");
        writeNtrip(request.toString());

        byte[] firstRtcm = readNtripHeader(input);
        emitRtkStatus("CONNECTED", "NTRIP baglandi: " + host + ":" + port + "/" + cleanMount);
        if (!latestGga.isEmpty()) writeNtrip(latestGga + "\r\n");
        startGgaTimer(Math.max(1000, ggaIntervalMs));
        if (firstRtcm.length > 0) writeRtcmToDevice(firstRtcm);

        byte[] buffer = new byte[8192];
        while (ntripRunning) {
          int read = input.read(buffer);
          if (read == -1) break;
          byte[] rtcm = new byte[read];
          System.arraycopy(buffer, 0, rtcm, 0, read);
          writeRtcmToDevice(rtcm);
        }

        if (ntripRunning) emitRtkStatus("DISCONNECTED", "NTRIP baglantisi kapandi.");
      } catch (IOException error) {
        if (ntripRunning) emitRtkError("NTRIP hatasi: " + error.getMessage(), "NTRIP_IO_ERROR");
      } finally {
        stopNtripInternal();
      }
    });

    JSObject result = new JSObject();
    result.put("status", "CONNECTING");
    call.resolve(result);
  }

  @PluginMethod
  public void stopNtrip(PluginCall call) {
    stopNtripInternal();
    emitRtkStatus("OFF", "NTRIP baglantisi durduruldu.");
    call.resolve();
  }

  @PluginMethod
  public void sendGga(PluginCall call) {
    String gga = call.getString("gga", "").trim();
    if (gga.isEmpty()) {
      call.resolve();
      return;
    }

    latestGga = gga;
    ioExecutor.execute(() -> {
      try {
        writeNtrip(gga + "\r\n");
        JSObject payload = new JSObject();
        payload.put("sentAt", System.currentTimeMillis());
        notifyListeners("ggaSent", payload, true);
      } catch (IOException error) {
        emitRtkError("GGA gonderilemedi: " + error.getMessage(), "NTRIP_GGA_FAILED");
      }
    });
    call.resolve();
  }

  @PluginMethod
  public void writeRtcm(PluginCall call) {
    String data = call.getString("data", "");
    if (data.isEmpty()) {
      call.reject("RTCM data zorunlu.", "RTCM_DATA_REQUIRED");
      return;
    }
    try {
      writeRtcmToDevice(Base64.decode(data, Base64.DEFAULT));
      call.resolve();
    } catch (IOException error) {
      call.reject("RTCM cihaza yazilamadi: " + error.getMessage(), "RTCM_WRITE_FAILED", error);
    }
  }

  private boolean ensureBluetoothPermission(PluginCall call, String callbackName) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
    if (getPermissionState("bluetooth") == PermissionState.GRANTED) return true;
    requestPermissionForAlias("bluetooth", call, callbackName);
    return false;
  }

  @PermissionCallback
  private void listBluetoothDevicesPerms(PluginCall call) {
    if (getPermissionState("bluetooth") == PermissionState.GRANTED) listBluetoothDevices(call);
    else call.reject("Bluetooth izni reddedildi.", "BLUETOOTH_PERMISSION_DENIED");
  }

  @PermissionCallback
  private void connectBluetoothPerms(PluginCall call) {
    if (getPermissionState("bluetooth") == PermissionState.GRANTED) connectBluetooth(call);
    else call.reject("Bluetooth izni reddedildi.", "BLUETOOTH_PERMISSION_DENIED");
  }

  private void startBluetoothReader() {
    ioExecutor.execute(() -> {
      StringBuilder line = new StringBuilder();
      byte[] buffer = new byte[1024];
      try {
        while (deviceReaderRunning && bluetoothInput != null) {
          int read = bluetoothInput.read(buffer);
          if (read == -1) break;
          for (int i = 0; i < read; i++) {
            char c = (char) (buffer[i] & 0xff);
            if (c == '\n') {
              emitNmeaLine(line.toString().trim());
              line.setLength(0);
            } else if (c != '\r') {
              line.append(c);
              if (line.length() > 512) line.setLength(0);
            }
          }
        }
      } catch (IOException error) {
        if (deviceReaderRunning) emitDeviceError("Bluetooth okuma hatasi: " + error.getMessage(), "BLUETOOTH_READ_FAILED");
      } finally {
        closeBluetooth();
        JSObject status = new JSObject();
        status.put("status", "DISCONNECTED");
        status.put("type", "android-bt-spp");
        notifyListeners("deviceStatus", status, true);
      }
    });
  }

  private void emitNmeaLine(String line) {
    if (line.isEmpty()) return;
    if (line.startsWith("$GNGGA") || line.startsWith("$GPGGA")) latestGga = line;
    JSObject payload = new JSObject();
    payload.put("line", line);
    payload.put("timestamp", System.currentTimeMillis());
    notifyListeners("nmea", payload, true);
  }

  private byte[] readNtripHeader(InputStream input) throws IOException {
    ByteArrayOutputStream all = new ByteArrayOutputStream();
    byte[] one = new byte[1];
    int match = 0;
    byte[] end = new byte[] { '\r', '\n', '\r', '\n' };

    while (ntripRunning) {
      int read = input.read(one);
      if (read == -1) throw new IOException("caster yanit vermedi");
      all.write(one[0]);
      match = one[0] == end[match] ? match + 1 : (one[0] == end[0] ? 1 : 0);
      if (match == end.length) break;
      if (all.size() > 8192) throw new IOException("caster header cok buyuk");
    }

    byte[] data = all.toByteArray();
    String text = new String(data, StandardCharsets.ISO_8859_1);
    int headerEnd = text.indexOf("\r\n\r\n");
    String header = headerEnd >= 0 ? text.substring(0, headerEnd) : text;
    String firstLine = header.split("\\r?\\n", 2)[0];
    if (!(firstLine.toUpperCase().startsWith("ICY 200") || firstLine.matches(".*\\s200\\s.*"))) {
      throw new IOException("caster reddetti: " + firstLine);
    }

    int restStart = headerEnd + 4;
    if (restStart < data.length) {
      byte[] rest = new byte[data.length - restStart];
      System.arraycopy(data, restStart, rest, 0, rest.length);
      return rest;
    }
    return new byte[0];
  }

  private synchronized void writeNtrip(String text) throws IOException {
    if (!ntripRunning || ntripOutput == null) return;
    ntripOutput.write(text.getBytes(StandardCharsets.US_ASCII));
    ntripOutput.flush();
  }

  private synchronized void writeRtcmToDevice(byte[] data) throws IOException {
    if (bluetoothOutput == null) throw new IOException("Bluetooth output hazir degil");
    bluetoothOutput.write(data);
    bluetoothOutput.flush();

    JSObject payload = new JSObject();
    payload.put("bytes", data.length);
    payload.put("timestamp", System.currentTimeMillis());
    notifyListeners("rtcmWritten", payload, true);
  }

  private void startGgaTimer(int intervalMs) {
    if (ggaFuture != null) ggaFuture.cancel(true);
    ggaFuture = scheduler.scheduleAtFixedRate(() -> {
      String gga = latestGga;
      if (gga == null || gga.trim().isEmpty()) return;
      try {
        writeNtrip(gga.trim() + "\r\n");
        JSObject payload = new JSObject();
        payload.put("sentAt", System.currentTimeMillis());
        notifyListeners("ggaSent", payload, true);
      } catch (IOException error) {
        emitRtkError("GGA gonderilemedi: " + error.getMessage(), "NTRIP_GGA_FAILED");
      }
    }, intervalMs, intervalMs, TimeUnit.MILLISECONDS);
  }

  private void emitRtkStatus(String status, String message) {
    JSObject payload = new JSObject();
    payload.put("status", status);
    payload.put("message", message);
    payload.put("timestamp", System.currentTimeMillis());
    notifyListeners("rtkStatus", payload, true);
  }

  private void emitRtkError(String message, String code) {
    JSObject payload = new JSObject();
    payload.put("status", "ERROR");
    payload.put("message", message);
    payload.put("code", code);
    payload.put("timestamp", System.currentTimeMillis());
    notifyListeners("rtkStatus", payload, true);
  }

  private void emitDeviceError(String message, String code) {
    JSObject payload = new JSObject();
    payload.put("status", "ERROR");
    payload.put("type", "android-bt-spp");
    payload.put("message", message);
    payload.put("code", code);
    notifyListeners("deviceStatus", payload, true);
  }

  private synchronized void closeBluetooth() {
    deviceReaderRunning = false;
    try {
      if (bluetoothInput != null) bluetoothInput.close();
    } catch (IOException ignored) {}
    try {
      if (bluetoothOutput != null) bluetoothOutput.close();
    } catch (IOException ignored) {}
    try {
      if (bluetoothSocket != null) bluetoothSocket.close();
    } catch (IOException ignored) {}
    bluetoothInput = null;
    bluetoothOutput = null;
    bluetoothSocket = null;
  }

  private synchronized void stopNtripInternal() {
    ntripRunning = false;
    if (ggaFuture != null) {
      ggaFuture.cancel(true);
      ggaFuture = null;
    }
    try {
      if (ntripOutput != null) ntripOutput.close();
    } catch (IOException ignored) {}
    try {
      if (ntripSocket != null) ntripSocket.close();
    } catch (IOException ignored) {}
    ntripOutput = null;
    ntripSocket = null;
  }

  @Override
  protected void handleOnDestroy() {
    stopNtripInternal();
    closeBluetooth();
    ioExecutor.shutdownNow();
    scheduler.shutdownNow();
    super.handleOnDestroy();
  }
}
