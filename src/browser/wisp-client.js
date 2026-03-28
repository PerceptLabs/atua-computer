/**
 * Wisp v2 WebSocket client — multiplexed TCP proxy.
 *
 * Protocol: https://github.com/nicbarker/wisp-protocol
 *
 * Frame format (little-endian):
 *   byte  0     : packet type
 *   bytes 1-4   : stream ID (uint32 LE)
 *   bytes 5+    : payload (type-dependent)
 *
 * Types:
 *   0x01 CONNECT  — client→server: payload = stream_type(1) + port(2 LE) + hostname(N)
 *   0x02 DATA     — bidi:          payload = raw bytes
 *   0x03 CONTINUE — server→client: payload = buffer_remaining(4 LE)
 *   0x04 CLOSE    — bidi:          payload = reason(1)
 *   0x05 INFO     — server→client: only in v2 extensions (ignored)
 *
 * Close reasons: 0x01=voluntary, 0x02=unexpected, 0x03=network_error, 0x41=connection_refused, 0x42=timeout, 0x43=unreachable
 */

export class WispClient {
  constructor(relayUrl) {
    this._relayUrl = relayUrl;
    this._ws = null;
    this._streams = new Map(); // streamId → { onData, onClose, onConnect, connected }
    this._nextStreamId = 1;
    this._ready = null;
    this._readyResolve = null;
  }

  /** Open WebSocket to relay. Resolves when connection is established. */
  async connect() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this._relayUrl);
      this._ws.binaryType = 'arraybuffer';
      this._ws.onopen = () => resolve();
      this._ws.onerror = (e) => reject(new Error('Wisp relay connection failed'));
      this._ws.onclose = () => this._handleWsClose();
      this._ws.onmessage = (e) => this._onMessage(e.data);
    });
  }

  /**
   * Open a TCP stream through the relay.
   * Returns streamId immediately. Connection status reported via callbacks.
   */
  createStream(host, port, { onData, onClose, onConnect } = {}) {
    const streamId = this._nextStreamId++;
    this._streams.set(streamId, {
      onData: onData || (() => {}),
      onClose: onClose || (() => {}),
      onConnect: onConnect || (() => {}),
      connected: false,
    });

    // Build CONNECT frame: type(1) + streamId(4 LE) + stream_type(1) + port(2 LE) + hostname(N)
    const hostBytes = new TextEncoder().encode(host);
    const frame = new Uint8Array(1 + 4 + 1 + 2 + hostBytes.length);
    const view = new DataView(frame.buffer);
    frame[0] = 0x01; // CONNECT
    view.setUint32(1, streamId, true); // stream ID, little-endian
    frame[5] = 0x01; // stream type: 0x01 = TCP
    view.setUint16(6, port, true); // destination port, little-endian
    frame.set(hostBytes, 8);

    this._ws.send(frame);
    return streamId;
  }

  /** Send data on a stream. */
  send(streamId, data) {
    if (!this._streams.has(streamId)) return;
    const payload = data instanceof Uint8Array ? data : new Uint8Array(data);

    // Build DATA frame: type(1) + streamId(4 LE) + payload
    const frame = new Uint8Array(1 + 4 + payload.length);
    const view = new DataView(frame.buffer);
    frame[0] = 0x02; // DATA
    view.setUint32(1, streamId, true);
    frame.set(payload, 5);

    this._ws.send(frame);
  }

  /** Close a stream. */
  close(streamId) {
    if (!this._streams.has(streamId)) return;

    // Build CLOSE frame: type(1) + streamId(4 LE) + reason(1)
    const frame = new Uint8Array(1 + 4 + 1);
    const view = new DataView(frame.buffer);
    frame[0] = 0x04; // CLOSE
    view.setUint32(1, streamId, true);
    frame[5] = 0x01; // reason: voluntary

    this._ws.send(frame);
    this._streams.delete(streamId);
  }

  /** Process incoming Wisp frame from relay. */
  _onMessage(data) {
    const buf = new Uint8Array(data);
    if (buf.length < 5) return;

    const type = buf[0];
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const streamId = view.getUint32(1, true);
    const stream = this._streams.get(streamId);

    switch (type) {
      case 0x02: // DATA
        if (stream) {
          const payload = buf.subarray(5);
          stream.onData(payload);
        }
        break;

      case 0x03: // CONTINUE (flow control / connect ack)
        if (stream && !stream.connected) {
          stream.connected = true;
          stream.onConnect();
        }
        break;

      case 0x04: // CLOSE
        if (stream) {
          const reason = buf.length > 5 ? buf[5] : 0;
          stream.onClose(reason);
          this._streams.delete(streamId);
        }
        break;

      case 0x05: // INFO (v2 extension, ignore)
        break;
    }
  }

  _handleWsClose() {
    // Notify all open streams
    for (const [id, stream] of this._streams) {
      stream.onClose(0x02); // unexpected
    }
    this._streams.clear();
  }

  /** Disconnect from relay. */
  disconnect() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._streams.clear();
  }

  get connected() {
    return this._ws && this._ws.readyState === WebSocket.OPEN;
  }
}
