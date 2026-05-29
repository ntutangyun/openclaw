/**
 * TCP-layer latency sampler for the Protocol Monitor.
 *
 * The app-layer ping protocol (`protocol/schema/ping.ts`) measures end-to-end
 * one-way latency including JS event-loop scheduling, TLS, and framing. This
 * sampler measures the *network floor* instead: the Linux kernel keeps a
 * smoothed round-trip time (`tcpi_rtt`) per TCP socket derived from ACK timing,
 * independent of whatever runs on top (WebSocket / HTTP / SSE).
 *
 * We read it with `ss -tinH state established` rather than a native
 * getsockopt(TCP_INFO) addon — Node's `net.Socket` exposes no getsockopt, and
 * `ss` (iproute2) needs zero extra dependencies. Each gateway WebSocket is
 * matched to its `ss` row by peer address:port (the client's ephemeral port is
 * unique), falling back to localPort:peerPort.
 *
 * Linux-only: on other platforms (or when `ss` is missing) the sampler is a
 * no-op and the app-layer ping remains the cross-platform baseline.
 */
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import type { WebSocket } from "ws";
import type { GatewayWsClient } from "./server/ws-types.js";

const DEFAULT_INTERVAL_MS = 10_000;
const SS_TIMEOUT_MS = 5_000;
const SS_MAX_BUFFER = 4 * 1024 * 1024;

export type TcpRttSample = { ts: number; srttMs: number; minRttMs?: number };

export type TcpInfoRecord = {
  localAddr: string;
  localPort: number;
  peerAddr: string;
  peerPort: number;
  srttMs: number;
  minRttMs?: number;
};

export type TcpModelEndpoint = { host: string; port: number };

export type TcpInfoSamplerOptions = {
  clients: Set<GatewayWsClient>;
  broadcast: (info: {
    source: "operator" | "node" | "agent-model";
    connId?: string;
    samples: TcpRttSample[];
  }) => void;
  /**
   * Current LLM provider endpoints (host:port from each `models.providers.*`
   * baseUrl). Re-read each tick so it follows config changes (e.g. sync-vllm).
   * Established sockets whose peer matches a resolved endpoint IP:port are
   * reported under source "agent-model". Omit to skip agent↔model sampling.
   */
  modelEndpoints?: () => TcpModelEndpoint[];
  intervalMs?: number;
  /** Injectable for tests; defaults to running `ss`. */
  runSs?: () => Promise<string>;
  /** Injectable for tests; defaults to DNS lookup (all addresses). */
  resolveHostIps?: (host: string) => Promise<string[]>;
  logger?: (msg: string) => void;
  now?: () => number;
};

async function defaultResolveHostIps(host: string): Promise<string[]> {
  try {
    const res = await lookup(host, { all: true });
    return res.map((r) => r.address);
  } catch {
    return [];
  }
}

function splitAddrPort(token: string): { addr: string; port: number } | null {
  const idx = token.lastIndexOf(":");
  if (idx <= 0) {
    return null;
  }
  const port = Number(token.slice(idx + 1));
  if (!Number.isInteger(port)) {
    return null;
  }
  // Strip IPv6 brackets and any %scope-id so it compares against socket addrs.
  let addr = token.slice(0, idx).replace(/^\[|\]$/g, "");
  const pct = addr.indexOf("%");
  if (pct >= 0) {
    addr = addr.slice(0, pct);
  }
  return { addr, port };
}

/** IPv4-mapped IPv6 and case differ between `ss` and Node's socket addrs. */
function normAddr(addr: string | undefined): string {
  if (!addr) {
    return "";
  }
  return addr.replace(/^::ffff:/i, "").toLowerCase();
}

/**
 * Parse `ss -tinH state established` output. Each socket is an address line
 * (`Recv-Q Send-Q Local:Port Peer:Port`) followed by an indented info line
 * carrying `rtt:<srtt>/<rttvar>` and `minrtt:<x>` (milliseconds). Tokens that
 * look like `addr:port` are detected positionally so the parse survives column
 * variation; the first is Local, the second is Peer.
 */
export function parseSsTcpInfo(output: string): TcpInfoRecord[] {
  const records: TcpInfoRecord[] = [];
  let pending: Omit<TcpInfoRecord, "srttMs" | "minRttMs"> | null = null;
  for (const line of output.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    if (/^\s/.test(line)) {
      // Indented info line for the most recent address line.
      if (!pending) {
        continue;
      }
      const rtt = /\brtt:([\d.]+)\/[\d.]+/.exec(line);
      if (rtt) {
        const minRtt = /\bminrtt:([\d.]+)/.exec(line);
        records.push({
          ...pending,
          srttMs: Number(rtt[1]),
          minRttMs: minRtt ? Number(minRtt[1]) : undefined,
        });
      }
      pending = null;
      continue;
    }
    const addrPorts = line.trim().split(/\s+/).filter((t) => /:\d+$/.test(t));
    const local = addrPorts[0] ? splitAddrPort(addrPorts[0]) : null;
    const peer = addrPorts[1] ? splitAddrPort(addrPorts[1]) : null;
    pending =
      local && peer
        ? { localAddr: local.addr, localPort: local.port, peerAddr: peer.addr, peerPort: peer.port }
        : null;
  }
  return records;
}

// `ss` (iproute2) lives in /usr/sbin on Debian, which is NOT on a non-root
// user's PATH (e.g. the containerized gateway runs as `gateway` with
// PATH=/usr/local/bin:/usr/bin:/bin). Resolve the binary by absolute path so a
// bare `execFile("ss")` doesn't ENOENT-disable the sampler despite ss being
// installed. Falls back to "ss" (PATH lookup) when no known path exists.
const SS_CANDIDATES = ["/usr/sbin/ss", "/sbin/ss", "/usr/bin/ss", "/bin/ss"];
let resolvedSsPath: string | null = null;
function resolveSsBinary(): string {
  if (resolvedSsPath) {
    return resolvedSsPath;
  }
  resolvedSsPath = SS_CANDIDATES.find((p) => existsSync(p)) ?? "ss";
  return resolvedSsPath;
}

function defaultRunSs(): Promise<string> {
  return new Promise((resolve, reject) => {
    // `-tin state established`, intentionally WITHOUT `-H`: some embedded
    // iproute2 builds (e.g. OpenWrt) lack the no-header flag, and parseSsTcpInfo
    // already ignores the header line, so dropping it is the portable choice.
    execFile(
      resolveSsBinary(),
      ["-tin", "state", "established"],
      { timeout: SS_TIMEOUT_MS, maxBuffer: SS_MAX_BUFFER },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/**
 * Start periodic TCP_INFO sampling. Returns a stop function. No-op (returns a
 * no-op stop) on non-Linux platforms unless a `runSs` is injected (tests).
 */
export function startTcpInfoSampler(opts: TcpInfoSamplerOptions): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const log = opts.logger ?? (() => {});

  if (process.platform !== "linux" && !opts.runSs) {
    log(`tcp-info sampler disabled: platform ${process.platform} has no \`ss\` TCP_INFO`);
    return () => {};
  }

  const runSs = opts.runSs ?? defaultRunSs;
  const resolveHostIps = opts.resolveHostIps ?? defaultResolveHostIps;
  let disabled = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (disabled || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const records = parseSsTcpInfo(await runSs());
      const byPeer = new Map<string, TcpInfoRecord>();
      const byPorts = new Map<string, TcpInfoRecord>();
      for (const r of records) {
        byPeer.set(`${normAddr(r.peerAddr)}|${r.peerPort}`, r);
        byPorts.set(`${r.localPort}|${r.peerPort}`, r);
      }
      const ts = now();
      for (const client of opts.clients) {
        const role = client.connect?.role;
        if (role !== "operator" && role !== "node") {
          continue;
        }
        const raw = (client.socket as WebSocket & { _socket?: Socket })._socket;
        const peerPort = raw?.remotePort;
        if (peerPort === undefined) {
          continue;
        }
        const localPort = raw?.localPort;
        const rec =
          byPeer.get(`${normAddr(raw?.remoteAddress)}|${peerPort}`) ??
          (localPort !== undefined ? byPorts.get(`${localPort}|${peerPort}`) : undefined);
        if (!rec) {
          continue;
        }
        opts.broadcast({
          source: role,
          connId: client.connId,
          samples: [{ ts, srttMs: rec.srttMs, minRttMs: rec.minRttMs }],
        });
      }

      // Agent ↔ Model: the gateway's outbound TCP to the LLM provider. Resolve
      // each configured endpoint host to IP(s) and match `ss` peers. Sockets are
      // pooled/transient, so this only yields a sample while a connection is up
      // (typically during/just after a model call). Report the lowest srtt among
      // matching sockets — idle keep-alives can carry a stale, inflated srtt.
      const endpoints = opts.modelEndpoints?.() ?? [];
      if (endpoints.length > 0) {
        const wanted = new Set<string>();
        for (const ep of endpoints) {
          for (const ip of await resolveHostIps(ep.host)) {
            wanted.add(`${normAddr(ip)}|${ep.port}`);
          }
        }
        let best: TcpInfoRecord | undefined;
        for (const r of records) {
          if (wanted.has(`${normAddr(r.peerAddr)}|${r.peerPort}`)) {
            if (!best || r.srttMs < best.srttMs) {
              best = r;
            }
          }
        }
        if (best) {
          opts.broadcast({
            source: "agent-model",
            samples: [{ ts, srttMs: best.srttMs, minRttMs: best.minRttMs }],
          });
        }
      }
    } catch (err) {
      // `ss` missing → disable permanently; transient failures → keep trying.
      if ((err as { code?: string } | null)?.code === "ENOENT") {
        disabled = true;
        log("tcp-info sampler disabled: `ss` not found on PATH");
      } else {
        log(`tcp-info sampler tick failed: ${(err as Error)?.message ?? String(err)}`);
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  // Fire once shortly after startup so the chart isn't empty for a full cycle.
  const kickoff = setTimeout(() => void tick(), 1_000);
  kickoff.unref?.();

  return () => {
    disabled = true;
    clearInterval(timer);
    clearTimeout(kickoff);
  };
}
