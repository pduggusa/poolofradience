// Browser front end: serves client/ and bridges WebSocket <-> the MUD's telnet port.
// `npm run web` starts the MUD in-process (unless MUD_EXTERNAL=1) and the web UI on WEB_PORT (default 8080, localhost only).
import { createServer } from "node:http";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { WebSocketServer } from "ws";
import { loadWorld } from "./world.js";
import { EGA } from "./ega.js";

const MUD_PORT = Number(process.env.PORT ?? 4000);
const WEB_PORT = Number(process.env.WEB_PORT ?? 8080);
const HOST = process.env.WEB_HOST ?? "127.0.0.1";
const PACKS = process.env.PACKS_DIR ?? join(import.meta.dirname, "..", "packs");
const CLIENT = join(import.meta.dirname, "..", "client");
if (!process.env.MUD_EXTERNAL) await import("./server.js");

const http = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(join(CLIENT, "index.html")));
  } else if (url === "/art.json") { // re-read every time so pack edits show up on refresh
    const w = loadWorld(PACKS);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
       .end(JSON.stringify({ palette: EGA.map(([r, g, b]) => `rgb(${r},${g},${b})`), sprites: Object.fromEntries(w.sprites) }));
  } else res.writeHead(404).end("not found");
});

const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 4096 });
wss.on("connection", (ws, req) => {
  ws.on("error", () => ws.terminate()); // a malformed frame must never become an uncaught exception
  const origin = req.headers.origin;
  let sameOrigin = true; // requests with no Origin (non-browser clients) are allowed; browsers always send one
  if (origin !== undefined) { try { sameOrigin = !!req.headers.host && new URL(origin).host === req.headers.host; } catch { sameOrigin = false; } }
  if (!sameOrigin) return void ws.close(1008, "bad origin"); // same-origin only
  const sock = connect(MUD_PORT, "127.0.0.1");
  const dec = new StringDecoder("utf8");
  let acc = "";
  const out = (o: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
  sock.on("connect", () => sock.write("@web\r\n"));
  sock.on("data", (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // 1. telnet negotiation: echo on/off becomes a control message; everything else is dropped
    const keep: number[] = [];
    for (let i = 0; i < buf.length; i++) {
      const next = buf[i + 1] ?? 0;
      if (buf[i] === 255 && i + 2 < buf.length && next >= 251 && next <= 254) {
        if (buf[i + 2] === 1) out({ t: "echo", on: next === 252 });
        i += 2;
      } else keep.push(buf[i]!);
    }
    // 2. split out-of-band scene lines (\x01{json}\n) from ordinary text
    acc += dec.write(Buffer.from(keep));
    for (;;) {
      const i = acc.indexOf("\x01");
      if (i < 0) { out({ t: "out", s: acc }); acc = ""; break; }
      if (i > 0) { out({ t: "out", s: acc.slice(0, i) }); acc = acc.slice(i); }
      const nl = acc.indexOf("\n");
      if (nl < 0) break; // wait for the rest of the line
      try { out({ t: "scene", d: JSON.parse(acc.slice(1, nl)) }); } catch { /* ignore a malformed scene */ }
      acc = acc.slice(nl + 1);
    }
  });
  sock.on("close", () => ws.close());
  sock.on("error", () => ws.close());
  ws.on("message", (m) => {
    try { const o = JSON.parse(String(m)); if (o.t === "in" && typeof o.s === "string") sock.write(o.s.replace(/[\r\n\x00-\x08\x0b-\x1f]/g, "").slice(0, 300) + "\r\n"); } catch { /* ignore */ }
  });
  ws.on("close", () => sock.destroy());
});
http.listen(WEB_PORT, HOST, () => console.log(`web client on http://${HOST}:${WEB_PORT}  (MUD on :${MUD_PORT})`));
