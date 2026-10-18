import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

/**
 * Minimal RFC 6455 WebSocket server — text frames only, enough for OSSP.
 * Hand-rolled to keep the daemon dependency-free (same spirit as sse.ts):
 *
 * - Handshake: Sec-WebSocket-Accept = base64(sha1(key + magic GUID))
 * - Client -> server frames are masked (spec) and unmasked here.
 * - Server -> client frames unmasked, with 7/16/64-bit length encoding.
 * - Opcodes handled: text(1), continuation(0), close(8), ping(9), pong(10).
 * - Fragmentation: control frames must be <=125B and unfragmented (enforced);
 *   text messages may arrive fragmented and are reassembled.
 *
 * Not implemented (out of scope for OSSP): binary frames, extensions,
 * compression (permessage-deflate), backpressure (writes are small envelopes).
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface WsHandlers {
  onMessage: (text: string) => void;
  onClose: (code: number, reason: string) => void;
}

export class WsConn {
  private socket: Socket;
  private handlers: WsHandlers = { onMessage: () => {}, onClose: () => {} };
  private buffer = "";
  private fragments: string[] = [];
  private fragmentOpcode = 0;
  private closed = false;
  lastActivity = Date.now();

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.close(1011, "socket error"));
    socket.on("close", () => this.finish(1006, "socket closed"));
  }

  /** Swap message/close handlers (auth phase -> authenticated phase). */
  setHandlers(handlers: WsHandlers): void {
    this.handlers = handlers;
  }

  /** Feed bytes that arrived with the 101 handshake (rare but legal). */
  feed(chunk: Buffer): void {
    this.onData(chunk);
  }

  /** Complete the server side of the handshake on an upgraded socket. */
  static accept(req: IncomingMessage, socket: Socket): WsConn | null {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || !key) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return null;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n",
    );
    return new WsConn(socket);
  }

  private onData(chunk: Buffer): void {
    this.lastActivity = Date.now();
    this.buffer += chunk.toString("latin1");
    for (;;) {
      const frame = this.tryParseFrame();
      if (!frame) return;
      this.handleFrame(frame.opcode, frame.fin, frame.payload);
    }
  }

  private tryParseFrame(): { opcode: number; fin: boolean; payload: Buffer } | null {
    const buf = Buffer.from(this.buffer, "latin1");
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.close(1009, "frame too large");
        return null;
      }
      len = Number(big);
      offset += 8;
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    this.buffer = this.buffer.slice(offset + len); // latin1: 1 byte per char
    return { opcode, fin, payload };
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    const isControl = opcode >= 0x8;
    if (isControl && (!fin || payload.length > 125)) {
      this.close(1002, "bad control frame");
      return;
    }
    switch (opcode) {
      case OP_CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8").slice(0, 120) : "";
        this.close(code, reason); // echo + close below handles the handshake
        return;
      }
      case OP_PING:
        this.writeFrame(OP_PONG, payload);
        return;
      case OP_PONG:
        return; // liveness already recorded
      case OP_TEXT:
      case OP_CONT: {
        if (opcode === OP_TEXT) this.fragmentOpcode = OP_TEXT;
        if (this.fragmentOpcode !== OP_TEXT) {
          this.close(1003, "binary frames not supported");
          return;
        }
        this.fragments.push(payload.toString("utf8"));
        if (fin) {
          const text = this.fragments.join("");
          this.fragments = [];
          this.fragmentOpcode = 0;
          if (!this.closed) this.handlers.onMessage(text);
        }
        return;
      }
      default:
        this.close(1002, "unsupported opcode");
    }
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.closed) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text: string): void {
    this.writeFrame(OP_TEXT, Buffer.from(text, "utf8"));
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2, "utf8");
    this.writeFrame(OP_CLOSE, body);
    this.finish(code, reason);
    // Give the close frame a moment to flush, then hard-close.
    this.socket.setTimeout(1000, () => this.socket.destroy());
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose(code, reason);
  }
}
