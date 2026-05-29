/**
 * Records the network endpoints (host:port) the agent actually opens TCP
 * connections to when calling LLM providers. Populated from the real request
 * URL in `buildGuardedModelFetch`, so it captures built-in providers (e.g.
 * openai) that have no explicit `baseUrl` in config — not just custom/local
 * providers like vLLM.
 *
 * Read by the Protocol Monitor's TCP-layer sampler to attribute `ss` sockets to
 * the agent↔model leg. Entries expire so a provider you've stopped using stops
 * being matched. Pure module (no agent/gateway imports) to avoid cycles.
 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export type ModelEndpoint = { host: string; port: number };

// key `${host}|${port}` -> last-seen epoch ms.
const lastSeen = new Map<string, number>();

/** Record the endpoint of a model request URL. Best-effort; ignores bad URLs. */
export function recordModelEndpoint(url: string, now: number = Date.now()): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!parsed.hostname || !Number.isFinite(port)) {
    return;
  }
  lastSeen.set(`${parsed.hostname}|${port}`, now);
}

/** Endpoints seen within `ttlMs`. Expired entries are pruned on read. */
export function getRecentModelEndpoints(
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now(),
): ModelEndpoint[] {
  const out: ModelEndpoint[] = [];
  for (const [key, ts] of lastSeen) {
    if (now - ts > ttlMs) {
      lastSeen.delete(key);
      continue;
    }
    const sep = key.lastIndexOf("|");
    out.push({ host: key.slice(0, sep), port: Number(key.slice(sep + 1)) });
  }
  return out;
}

/** Test helper. */
export function _resetModelEndpointRegistry(): void {
  lastSeen.clear();
}
