import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { WebSocketServer, WebSocket, RawData } from "ws";
import net from "net";
import tls from "tls";
import path from "path";
import dns from "dns/promises";
import { calculateDistance } from "./src/lib/geo.ts";

type NtripConfig = {
  host: string;
  port: number;
  mountPoint: string;
  username?: string;
  password?: string;
  useTls?: boolean;
};

type NtripSession = {
  sendGga: (sentence: string) => void;
  close: () => void;
};

const DEFAULT_PORT = 3000;
const NTRIP_ALLOWED_PORTS = new Set(
  (process.env.NTRIP_ALLOWED_PORTS || "80,443,2101,2102,2103")
    .split(",")
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535),
);
const NTRIP_ALLOWED_HOSTS = new Set(
  (process.env.NTRIP_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const MESSAGE_LIMIT_WINDOW_MS = 10_000;
const MESSAGE_LIMIT_PER_WINDOW = 120;
const MAX_WS_PAYLOAD_BYTES = 32 * 1024;

function isProductionMode(): boolean {
  return process.env.NODE_ENV === "production" || process.argv.includes("--production");
}

function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;

  try {
    const originUrl = new URL(origin);
    const allowedOrigins = new Set(
      (process.env.ALLOWED_ORIGINS || process.env.APP_URL || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );

    if (host && originUrl.host === host) return true;
    return allowedOrigins.has(originUrl.origin);
  } catch {
    return false;
  }
}

function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }

  return true;
}

function wsPayloadToBuffer(message: RawData): Buffer {
  if (Buffer.isBuffer(message)) return message;
  if (message instanceof ArrayBuffer) return Buffer.from(message);
  if (Array.isArray(message)) return Buffer.concat(message);
  return Buffer.from(String(message));
}

async function validateNtripTarget(host: string, port: number): Promise<string | null> {
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedHost || normalizedHost.length > 253 || /[^a-z0-9.-]/i.test(normalizedHost)) {
    return "NTRIP host gecersiz.";
  }

  if (!NTRIP_ALLOWED_PORTS.has(port)) {
    return `NTRIP port izinli degil: ${port}`;
  }

  if (NTRIP_ALLOWED_HOSTS.size > 0 && !NTRIP_ALLOWED_HOSTS.has(normalizedHost)) {
    return "NTRIP host izinli listede degil.";
  }

  try {
    const addresses = net.isIP(normalizedHost)
      ? [{ address: normalizedHost }]
      : await dns.lookup(normalizedHost, { all: true, verbatim: true });

    if (addresses.length === 0 || addresses.some((entry) => isPrivateOrReservedIp(entry.address))) {
      return "NTRIP host ozel veya ayrilmis IP adresine cozuluyor.";
    }
  } catch {
    return "NTRIP host DNS ile cozumlenemedi.";
  }

  return null;
}

function createNtripSession(
  config: NtripConfig,
  onStatus: (status: string, message: string) => void,
  onRtcm: (chunk: Buffer) => void,
  onError: (message: string) => void,
): NtripSession {
  const mountPoint = `/${String(config.mountPoint || '').replace(/^\/+/, '')}`;
  const port = Number(config.port || (config.useTls ? 443 : 2101));
  const socket = config.useTls
    ? tls.connect({ host: config.host, port, servername: config.host })
    : net.connect({ host: config.host, port });

  let closed = false;
  let headerComplete = false;
  let headerBuffer = Buffer.alloc(0);
  let latestGga = '';

  const send = (data: string | Buffer) => {
    if (!closed && socket.writable) socket.write(data);
  };

  const sendGga = (sentence: string) => {
    latestGga = sentence.trim();
    if (headerComplete && latestGga) send(`${latestGga}\r\n`);
  };

  socket.setNoDelay(true);
  socket.setTimeout(30000);

  socket.on('connect', () => {
    const auth = config.username || config.password
      ? `Authorization: Basic ${Buffer.from(`${config.username || ''}:${config.password || ''}`).toString('base64')}\r\n`
      : '';

    const request =
      `GET ${mountPoint} HTTP/1.1\r\n` +
      `Host: ${config.host}:${port}\r\n` +
      `Ntrip-Version: Ntrip/2.0\r\n` +
      `User-Agent: NTRIP SlopeFixRTK/1.0\r\n` +
      auth +
      `Connection: close\r\n\r\n`;

    send(request);
    onStatus('CONNECTING', 'NTRIP caster yaniti bekleniyor.');
  });

  socket.on('data', (chunk) => {
    if (headerComplete) {
      onRtcm(chunk);
      return;
    }

    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    const headerEnd = headerBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      if (headerBuffer.length > 8192) {
        onError('NTRIP caster gecersiz veya cok buyuk yanit dondu.');
        socket.destroy();
      }
      return;
    }

    const headerText = headerBuffer.slice(0, headerEnd).toString('utf8');
    const firstLine = headerText.split(/\r?\n/, 1)[0] || '';
    const ok = /^ICY 200/i.test(firstLine) || /\s200\s/.test(firstLine);

    if (!ok) {
      onError(`NTRIP baglantisi reddedildi: ${firstLine || 'yanit yok'}`);
      socket.destroy();
      return;
    }

    headerComplete = true;
    onStatus('CONNECTED', `NTRIP baglandi: ${config.host}:${port}${mountPoint}`);

    if (latestGga) send(`${latestGga}\r\n`);

    const rest = headerBuffer.slice(headerEnd + 4);
    if (rest.length > 0) onRtcm(rest);
    headerBuffer = Buffer.alloc(0);
  });

  socket.on('timeout', () => {
    onError('NTRIP baglantisi zaman asimina ugradi.');
    socket.destroy();
  });

  socket.on('error', (error) => {
    if (!closed) onError(`NTRIP soket hatasi: ${error.message}`);
  });

  socket.on('close', () => {
    if (!closed) onStatus('DISCONNECTED', 'NTRIP baglantisi kapandi.');
    closed = true;
  });

  return {
    sendGga,
    close: () => {
      closed = true;
      socket.destroy();
    },
  };
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || DEFAULT_PORT);

  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  // Create an HTTP server so we can attach WS
  const server = createServer(app);
  
  // Attach app WebSocket Server only on /ws so it does not intercept Vite HMR.
  const wss = new WebSocketServer({ noServer: true });
  const activeConnections = new Set<WebSocket>();

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (pathname !== '/ws') return;

    if (!isAllowedOrigin(request.headers.origin, request.headers.host)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    activeConnections.add(ws);
    console.log('Yeni istemci bağlandı.');

    let referencePoint: any = null;
    let targetDistance = 1.50; 
    let scaleFactor = 1.0; 
    let ntripSession: NtripSession | null = null;

    const sendJson = (payload: any) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    const stopNtrip = () => {
      if (ntripSession) {
        ntripSession.close();
        ntripSession = null;
      }
    };

    let windowStartedAt = Date.now();
    let messagesInWindow = 0;

    ws.on('message', async (message) => {
      try {
        const messageBuffer = wsPayloadToBuffer(message);
        if (messageBuffer.length > MAX_WS_PAYLOAD_BYTES) {
          sendJson({ type: 'ERROR', message: 'WebSocket mesaji cok buyuk.' });
          ws.close(1009, 'Payload too large');
          return;
        }

        const now = Date.now();
        if (now - windowStartedAt > MESSAGE_LIMIT_WINDOW_MS) {
          windowStartedAt = now;
          messagesInWindow = 0;
        }
        messagesInWindow++;
        if (messagesInWindow > MESSAGE_LIMIT_PER_WINDOW) {
          sendJson({ type: 'ERROR', message: 'WebSocket mesaj limiti asildi.' });
          ws.close(1008, 'Rate limit exceeded');
          return;
        }

        const payload = JSON.parse(messageBuffer.toString('utf8'));
        
        if (payload.type === 'SET_TARGET') {
          targetDistance = payload.data;
        }
        else if (payload.type === 'SET_SCALE') {
          scaleFactor = payload.data;
          ws.send(JSON.stringify({ type: 'INFO', message: `Kalibrasyon uygulandı. Yeni çarpan: ${scaleFactor.toFixed(4)}` }));
        }
        else if (payload.type === 'SET_REF') {
          referencePoint = payload.data;
          ws.send(JSON.stringify({ type: 'INFO', message: 'Referans noktası sunucuda başarıyla ayarlandı.' }));
        }
        else if (payload.type === 'START_NTRIP') {
          stopNtrip();

          const config = payload.data || {};
          if (!config.host || !config.mountPoint) {
            sendJson({ type: 'NTRIP_ERROR', message: 'NTRIP host ve mountpoint zorunlu.' });
            return;
          }

          const host = String(config.host).trim();
          const port = Number(config.port || 2101);
          const validationError = await validateNtripTarget(host, port);
          if (validationError) {
            sendJson({ type: 'NTRIP_ERROR', message: validationError });
            return;
          }

          ntripSession = createNtripSession(
            {
              host,
              port,
              mountPoint: String(config.mountPoint).trim(),
              username: String(config.username || ''),
              password: String(config.password || ''),
              useTls: Boolean(config.useTls),
            },
            (status, statusMessage) => sendJson({ type: 'NTRIP_STATUS', status, message: statusMessage }),
            (chunk) => sendJson({ type: 'RTCM', data: chunk.toString('base64'), bytes: chunk.length }),
            (errorMessage) => {
              sendJson({ type: 'NTRIP_ERROR', message: errorMessage });
              stopNtrip();
            },
          );

          sendJson({ type: 'NTRIP_STATUS', status: 'CONNECTING', message: 'NTRIP baglantisi baslatildi.' });
          if (payload.gga) ntripSession.sendGga(String(payload.gga));
        }
        else if (payload.type === 'STOP_NTRIP') {
          stopNtrip();
          sendJson({ type: 'NTRIP_STATUS', status: 'OFF', message: 'NTRIP baglantisi durduruldu.' });
        }
        else if (payload.type === 'NTRIP_GGA') {
          if (ntripSession && payload.data) {
            ntripSession.sendGga(String(payload.data));
          }
        }
        else if (payload.type === 'CUR_POS') {
          if (!referencePoint) {
            // Ignore silently or send error 
            // ws.send(JSON.stringify({ type: 'ERROR', message: 'Önce referans noktası belirleyin.' }));
            return;
          }
          const cur = payload.data;
          
          const rawResult = calculateDistance(
            referencePoint.lat, referencePoint.lon, referencePoint.alt,
            cur.lat, cur.lon, cur.alt
          );

          // Kalibrasyon faktörünü hesaplamalara uygula
          const scaledHorizontal = rawResult.horizontalDistance * scaleFactor;
          const scaledReal = rawResult.realDistance * scaleFactor;
          
          // Ölçeklenmiş yeni mesafeye göre hata payını ve yönlendirmeyi güncelle
          const error = scaledReal - targetDistance;
          let direction = 'WAITING';
          if (Math.abs(error) <= 0.02) {
            direction = 'OK';
          } else if (error > 0) {
            direction = 'BACK';
          } else {
            direction = 'FORWARD';
          }

          const result = {
            ...rawResult,
            horizontalDistance: scaledHorizontal,
            realDistance: scaledReal,
            error,
            direction
          };

          ws.send(JSON.stringify({ type: 'CORRECTION', data: result }));
        }
      } catch (err) {
        console.error('WS Mesaj Hatası:', err);
      }
    });

    ws.on('close', () => {
      stopNtrip();
      activeConnections.delete(ws);
      console.log('İstemci bağlantısı koptu.');
    });
  });

  // Vite middleware for development
  if (!isProductionMode()) {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} zaten kullaniliyor. PORT ortam degiskeniyle farkli port secin.`);
    } else {
      console.error('Sunucu baslatma hatasi:', error);
    }
    process.exit(1);
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Sunucu başlatıldı: http://localhost:${PORT}`);
  });
}

startServer();
