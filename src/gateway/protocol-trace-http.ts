import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import { authorizeGatewayHttpRequestOrReply } from "./http-utils.js";
import { getProtocolTraceStore } from "./protocol-trace-store.js";

export type ProtocolTraceHttpOpts = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

export async function handleProtocolTracesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ProtocolTraceHttpOpts,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/protocol-traces/export") {
    return handleExport(req, res, opts);
  }
  if (pathname === "/protocol-traces" && req.method === "DELETE") {
    return handleClear(req, res, opts);
  }

  return false;
}

async function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ProtocolTraceHttpOpts,
): Promise<boolean> {
  const cfg = loadConfig();
  const result = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  return result !== null;
}

async function handleExport(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ProtocolTraceHttpOpts,
): Promise<boolean> {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }
  const ok = await authorize(req, res, opts);
  if (!ok) {
    return true;
  }

  const store = getProtocolTraceStore();
  if (!store) {
    sendJson(res, 503, { error: "Protocol trace store not initialized" });
    return true;
  }

  const files = store.getActiveTraceFiles();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Content-Disposition", `attachment; filename="protocol-traces-${ts}.jsonl"`);
  res.statusCode = 200;

  if (files.length === 0) {
    res.end();
    return true;
  }

  let idx = 0;
  const streamNext = () => {
    if (idx >= files.length) {
      res.end();
      return;
    }
    const filePath = files[idx++] ?? "";
    if (!filePath || !fs.existsSync(filePath)) {
      streamNext();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on("end", streamNext);
    stream.on("error", () => {
      streamNext();
    });
    stream.pipe(res, { end: false });
  };
  streamNext();

  return true;
}

async function handleClear(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ProtocolTraceHttpOpts,
): Promise<boolean> {
  const ok = await authorize(req, res, opts);
  if (!ok) {
    return true;
  }
  const store = getProtocolTraceStore();
  if (!store) {
    sendJson(res, 503, { error: "Protocol trace store not initialized" });
    return true;
  }
  store.clearTraces();
  sendJson(res, 200, { ok: true });
  return true;
}
