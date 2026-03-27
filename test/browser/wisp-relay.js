/**
 * Minimal Wisp v2 relay server for testing.
 * Accepts WebSocket connections, proxies TCP via Wisp framing.
 *
 * Usage: const { port, close } = await startWispRelay();
 */

import { WebSocketServer } from 'ws';
import * as net from 'node:net';

/**
 * Attach a Wisp relay to an existing HTTP server (same port, via upgrade).
 * This avoids cross-origin WebSocket issues in browser tests.
 */
export function attachWispRelay(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  setupWispHandlers(wss);
  return { close: () => wss.close() };
}

export async function startWispRelay(listenPort = 0) {
  const wss = new WebSocketServer({ port: listenPort });

  await new Promise((resolve) => wss.on('listening', resolve));
  const port = wss.address().port;
  setupWispHandlers(wss);

  return {
    port,
    url: `ws://localhost:${port}`,
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
}

function setupWispHandlers(wss) {
  wss.on('connection', (ws) => {
    const streams = new Map(); // streamId → net.Socket

    ws.on('message', (raw) => {
      const buf = Buffer.from(raw);
      if (buf.length < 5) return;

      const type = buf[0];
      const streamId = buf.readUInt32LE(1);

      switch (type) {
        case 0x01: { // CONNECT
          const streamType = buf[5]; // 0x01=TCP, 0x02=UDP
          const destPort = buf.readUInt16LE(6);
          const hostname = buf.subarray(8).toString('utf8');

          if (streamType !== 0x01) {
            // Only TCP supported — send CLOSE
            sendClose(ws, streamId, 0x02);
            break;
          }

          const sock = net.createConnection({ host: hostname, port: destPort }, () => {
            streams.set(streamId, sock);
            // Send CONTINUE frame to signal connection established
            // CONTINUE: type(1) + streamId(4) + buffer_remaining(4)
            const cont = Buffer.alloc(9);
            cont[0] = 0x03;
            cont.writeUInt32LE(streamId, 1);
            cont.writeUInt32LE(131072, 5); // buffer remaining
            ws.send(cont);
          });

          sock.on('data', (data) => {
            // Send DATA frame
            const frame = Buffer.alloc(5 + data.length);
            frame[0] = 0x02;
            frame.writeUInt32LE(streamId, 1);
            data.copy(frame, 5);
            try { ws.send(frame); } catch {}
          });

          sock.on('end', () => {
            sendClose(ws, streamId, 0x01); // voluntary
            streams.delete(streamId);
          });

          sock.on('error', (err) => {
            const reason = err.code === 'ECONNREFUSED' ? 0x41
                         : err.code === 'ETIMEDOUT' ? 0x42
                         : err.code === 'EHOSTUNREACH' ? 0x43
                         : 0x03; // network error
            sendClose(ws, streamId, reason);
            streams.delete(streamId);
          });

          break;
        }

        case 0x02: { // DATA — forward to TCP socket
          const sock = streams.get(streamId);
          if (sock) {
            sock.write(buf.subarray(5));
          }
          break;
        }

        case 0x04: { // CLOSE
          const sock = streams.get(streamId);
          if (sock) {
            sock.destroy();
            streams.delete(streamId);
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      for (const sock of streams.values()) sock.destroy();
      streams.clear();
    });
  });
}

function sendClose(ws, streamId, reason) {
  const frame = Buffer.alloc(6);
  frame[0] = 0x04;
  frame.writeUInt32LE(streamId, 1);
  frame[5] = reason;
  try { ws.send(frame); } catch {}
}
