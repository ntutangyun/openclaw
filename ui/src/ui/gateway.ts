import {
  type ClockSyncMetrics,
  type ClockSyncSample,
  computeClockSyncSample,
  pickBestSample,
  PING_INTERVAL_MS,
  type PingOneWaySample,
  type RxLatencySample,
  RX_REPORT_BUFFER_CAP,
  RX_REPORT_INTERVAL_MS,
  TIME_SYNC_BURST_INTERVAL_MS,
  TIME_SYNC_BURST_SAMPLES,
  TIME_SYNC_PERIODIC_INTERVAL_MS,
} from "../../../src/gateway/clock-sync.js";
import { buildDeviceAuthPayload } from "../../../src/gateway/device-auth.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../../src/gateway/protocol/client-info.js";
import {
  ConnectErrorDetailCodes,
  formatConnectErrorMessage,
  readConnectErrorRecoveryAdvice,
  readConnectErrorDetailCode,
} from "../../../src/gateway/protocol/connect-error-details.js";
import {
  isRetryableGatewayStartupUnavailableError,
  resolveGatewayStartupRetryAfterMs,
} from "../../../src/gateway/protocol/startup-unavailable.js";
import { clearDeviceAuthToken, loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth.ts";
import { loadOrCreateDeviceIdentity, signDevicePayload } from "./device-identity.ts";
import { generateUUID } from "./uuid.ts";

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
};

export type GatewayErrorInfo = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

export class GatewayRequestError extends Error {
  readonly gatewayCode: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(error: GatewayErrorInfo) {
    super(formatConnectErrorMessage({ message: error.message, details: error.details }));
    this.name = "GatewayRequestError";
    this.gatewayCode = error.code;
    this.details = error.details;
    this.retryable = error.retryable === true;
    this.retryAfterMs = error.retryAfterMs;
  }
}

export function resolveGatewayErrorDetailCode(
  error: { details?: unknown } | null | undefined,
): string | null {
  return readConnectErrorDetailCode(error?.details);
}

/**
 * Auth errors that won't resolve without user action — don't auto-reconnect.
 *
 * NOTE: AUTH_TOKEN_MISMATCH is intentionally NOT included here because the
 * browser client supports a bounded one-time retry with a cached device token
 * when the endpoint is trusted. Reconnect suppression for mismatch is handled
 * with client state (after retry budget is exhausted).
 */
export function isNonRecoverableAuthError(error: GatewayErrorInfo | undefined): boolean {
  if (!error) {
    return false;
  }
  const code = resolveGatewayErrorDetailCode(error);
  return (
    code === ConnectErrorDetailCodes.AUTH_TOKEN_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH ||
    code === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
    code === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH ||
    code === ConnectErrorDetailCodes.PAIRING_REQUIRED ||
    code === ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED ||
    code === ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED
  );
}

function isTrustedRetryEndpoint(url: string): boolean {
  try {
    const gatewayUrl = new URL(url, window.location.href);
    const host = gatewayUrl.hostname.trim().toLowerCase();
    const isLoopbackHost =
      host === "localhost" || host === "::1" || host === "[::1]" || host === "127.0.0.1";
    const isLoopbackIPv4 = host.startsWith("127.");
    if (isLoopbackHost || isLoopbackIPv4) {
      return true;
    }
    const pageUrl = new URL(window.location.href);
    return gatewayUrl.host === pageUrl.host;
  } catch {
    return false;
  }
}

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  server?: {
    version?: string;
    connId?: string;
  };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth: {
    deviceToken?: string;
    role: string;
    scopes: string[];
    issuedAtMs?: number;
  };
  canvasHostUrl?: string;
  policy?: { tickIntervalMs?: number };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  method?: string;
};

type SelectedConnectAuth = {
  authToken?: string;
  authDeviceToken?: string;
  authPassword?: string;
  resolvedDeviceToken?: string;
  storedToken?: string;
  canFallbackToShared: boolean;
};

const CONTROL_UI_OPERATOR_ROLE = "operator";

export const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;

export type GatewayConnectAuth = {
  token?: string;
  deviceToken?: string;
  password?: string;
};

export type GatewayConnectDevice = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

export type GatewayConnectClientInfo = {
  id: GatewayClientName;
  version: string;
  platform: string;
  mode: GatewayClientMode;
  instanceId?: string;
};

export type GatewayConnectParams = {
  minProtocol: 3;
  maxProtocol: 3;
  client: GatewayConnectClientInfo;
  role: string;
  scopes: string[];
  device?: GatewayConnectDevice;
  caps: string[];
  auth?: GatewayConnectAuth;
  userAgent: string;
  locale: string;
};

type ConnectPlan = {
  role: string;
  scopes: string[];
  client: GatewayConnectClientInfo;
  explicitGatewayToken?: string;
  selectedAuth: SelectedConnectAuth;
  auth?: GatewayConnectAuth;
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
  device?: GatewayConnectDevice;
};

type DeviceTokenRetryDecision = {
  deviceTokenRetryBudgetUsed: boolean;
  authDeviceToken?: string;
  explicitGatewayToken?: string;
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
  storedToken?: string;
  canRetryWithDeviceTokenHint: boolean;
  url: string;
};

export type GatewayBrowserClientOptions = {
  url: string;
  token?: string;
  password?: string;
  clientName?: GatewayClientName;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: GatewayEventFrame) => void;
  onClose?: (info: { code: number; reason: string; error?: GatewayErrorInfo }) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

export type GatewayEventListener = (evt: GatewayEventFrame) => void;

// 4008 = application-defined code (browser rejects 1008 "Policy Violation")
const CONNECT_FAILED_CLOSE_CODE = 4008;
const STARTUP_RETRY_CLOSE_CODE = 4013;

function buildGatewayConnectAuth(
  selectedAuth: SelectedConnectAuth,
): GatewayConnectAuth | undefined {
  const authToken = selectedAuth.authToken;
  if (!(authToken || selectedAuth.authPassword)) {
    return undefined;
  }
  return {
    token: authToken,
    deviceToken: selectedAuth.authDeviceToken ?? selectedAuth.resolvedDeviceToken,
    password: selectedAuth.authPassword,
  };
}

async function buildGatewayConnectDevice(params: {
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
  client: GatewayConnectClientInfo;
  role: string;
  scopes: string[];
  authToken?: string;
  connectNonce: string | null;
}): Promise<GatewayConnectDevice | undefined> {
  const { deviceIdentity } = params;
  if (!deviceIdentity) {
    return undefined;
  }
  const signedAtMs = Date.now();
  const nonce = params.connectNonce ?? "";
  const payload = buildDeviceAuthPayload({
    deviceId: deviceIdentity.deviceId,
    clientId: params.client.id,
    clientMode: params.client.mode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs,
    token: params.authToken ?? null,
    nonce,
  });
  const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
  return {
    id: deviceIdentity.deviceId,
    publicKey: deviceIdentity.publicKey,
    signature,
    signedAt: signedAtMs,
    nonce,
  };
}

export function shouldRetryWithDeviceToken(params: DeviceTokenRetryDecision): boolean {
  return (
    !params.deviceTokenRetryBudgetUsed &&
    !params.authDeviceToken &&
    Boolean(params.explicitGatewayToken) &&
    Boolean(params.deviceIdentity) &&
    Boolean(params.storedToken) &&
    params.canRetryWithDeviceTokenHint &&
    isTrustedRetryEndpoint(params.url)
  );
}

type TimeSyncResponse = { peerT0: number; gatewayT1: number; gatewayT2: number };

export class GatewayBrowserClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private lastSeq: number | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: number | null = null;
  private connectGeneration = 0;
  private backoffMs = 800;
  private pendingConnectError: GatewayErrorInfo | undefined;
  private pendingDeviceTokenRetry = false;
  private deviceTokenRetryBudgetUsed = false;
  // Clock-sync state. `clockOffsetMs` is applied to outbound `sentAt` so the
  // gateway's `oneWayLatencyMs = capturedAt - sentAt` formula stays correct
  // regardless of OS clock skew between this browser and the gateway host.
  private clockOffsetMs = 0;
  private clockSyncTimer: number | null = null;
  private clockSyncInFlight = false;
  private lastClockSyncMetrics: ClockSyncMetrics | null = null;
  // Rx-latency capture state. Each inbound frame with `sentAt` produces a
  // sample; periodic flushes batch them to `protocol-traces.rx-report` so the
  // gateway can chart the gateway→operator direction (which it can't measure
  // from its own clock alone).
  private rxSamples: RxLatencySample[] = [];
  private rxReportTimer: number | null = null;
  private rxReportInFlight = false;
  // Dedicated ping-protocol state for protocol-monitor latency. Independent
  // of time.sync / rx-samples; uses single-clock RTT measurements.
  private pingTimer: number | null = null;
  private pingInFlight = false;
  private pendingStartupReconnectDelayMs: number | null = null;
  private eventListeners = new Set<GatewayEventListener>();

  constructor(private opts: GatewayBrowserClientOptions) {}

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    this.clearConnectTimer();
    this.stopClockSyncSchedule();
    this.stopRxReportSchedule();
    this.stopPingSchedule();
    this.ws?.close();
    this.ws = null;
    this.pendingConnectError = undefined;
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.pendingStartupReconnectDelayMs = null;
    this.flushPending(new Error("gateway client stopped"));
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect() {
    if (this.closed) {
      return;
    }
    const ws = new WebSocket(this.opts.url);
    const generation = ++this.connectGeneration;
    this.ws = ws;
    ws.addEventListener("open", () => this.queueConnect(ws, generation));
    ws.addEventListener("message", (ev) => {
      if (!this.isActiveSocket(ws, generation)) {
        return;
      }
      this.handleMessage(ws, generation, String(ev.data ?? ""));
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) {
        return;
      }
      const reason = ev.reason ?? "";
      const connectError = this.pendingConnectError;
      this.pendingConnectError = undefined;
      this.ws = null;
      // The next gateway process may be a fresh restart with a slightly
      // different clock; reset offset rather than carrying a stale value.
      this.stopClockSyncSchedule();
      this.stopRxReportSchedule();
      this.stopPingSchedule();
      this.rxSamples = [];
      this.clockOffsetMs = 0;
      this.lastClockSyncMetrics = null;
      if (this.pendingStartupReconnectDelayMs !== null) {
        this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
        this.scheduleReconnect();
        return;
      }
      this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
      this.opts.onClose?.({ code: ev.code, reason, error: connectError });
      const connectErrorCode = resolveGatewayErrorDetailCode(connectError);
      if (
        connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH &&
        this.deviceTokenRetryBudgetUsed &&
        !this.pendingDeviceTokenRetry
      ) {
        return;
      }
      if (!isNonRecoverableAuthError(connectError)) {
        this.scheduleReconnect();
      }
    });
    ws.addEventListener("error", () => {
      // ignored; close handler will fire
    });
  }

  private scheduleReconnect() {
    if (this.closed) {
      return;
    }
    const startupDelay = this.pendingStartupReconnectDelayMs;
    this.pendingStartupReconnectDelayMs = null;
    const delay = startupDelay ?? this.backoffMs;
    if (startupDelay === null) {
      this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    }
    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      this.connect();
    }, delay);
  }

  private flushPending(err: Error) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private buildConnectClient(): GatewayConnectClientInfo {
    return {
      id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: this.opts.clientVersion ?? "control-ui",
      platform: this.opts.platform ?? navigator.platform ?? "web",
      mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
      instanceId: this.opts.instanceId,
    };
  }

  private buildConnectParams(plan: ConnectPlan): GatewayConnectParams {
    return {
      minProtocol: 3,
      maxProtocol: 3,
      client: plan.client,
      role: plan.role,
      scopes: plan.scopes,
      device: plan.device,
      caps: ["tool-events"],
      auth: plan.auth,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };
  }

  private async buildConnectPlan(connectNonce: string | null): Promise<ConnectPlan> {
    const role = CONTROL_UI_OPERATOR_ROLE;
    const scopes = [...CONTROL_UI_OPERATOR_SCOPES];
    const client = this.buildConnectClient();
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const explicitPassword = this.opts.password?.trim() || undefined;

    // crypto.subtle is only available in secure contexts (HTTPS, localhost).
    // Over plain HTTP, we skip device identity and fall back to token-only auth.
    // Gateways may reject this unless gateway.controlUi.allowInsecureAuth is enabled.
    const isSecureContext = typeof crypto !== "undefined" && !!crypto.subtle;
    let deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null = null;
    let selectedAuth: SelectedConnectAuth = {
      authToken: explicitGatewayToken,
      authPassword: explicitPassword,
      canFallbackToShared: false,
    };

    if (isSecureContext) {
      deviceIdentity = await loadOrCreateDeviceIdentity();
      selectedAuth = this.selectConnectAuth({
        role,
        deviceId: deviceIdentity.deviceId,
      });
    }

    return {
      role,
      scopes,
      client,
      explicitGatewayToken,
      selectedAuth,
      auth: buildGatewayConnectAuth(selectedAuth),
      deviceIdentity,
      device: await buildGatewayConnectDevice({
        deviceIdentity,
        client,
        role,
        scopes,
        authToken: selectedAuth.authToken,
        connectNonce,
      }),
    };
  }

  private handleConnectHello(
    hello: GatewayHelloOk,
    plan: ConnectPlan,
    ws: WebSocket,
    generation: number,
  ) {
    if (!this.isActiveSocket(ws, generation)) {
      return;
    }
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.pendingStartupReconnectDelayMs = null;
    if (hello?.auth?.deviceToken && plan.deviceIdentity) {
      storeDeviceAuthToken({
        deviceId: plan.deviceIdentity.deviceId,
        role: hello.auth.role ?? plan.role,
        token: hello.auth.deviceToken,
        scopes: hello.auth.scopes ?? [],
      });
    }
    this.backoffMs = 800;
    this.opts.onHello?.(hello);
    this.startClockSyncSchedule();
    this.startRxReportSchedule();
    this.startPingSchedule();
  }

  private handleConnectFailure(err: unknown, plan: ConnectPlan, ws: WebSocket, generation: number) {
    if (!this.isActiveSocket(ws, generation)) {
      return;
    }
    const connectErrorCode =
      err instanceof GatewayRequestError ? resolveGatewayErrorDetailCode(err) : null;
    const recoveryAdvice =
      err instanceof GatewayRequestError ? readConnectErrorRecoveryAdvice(err.details) : {};
    const retryWithDeviceTokenRecommended =
      recoveryAdvice.recommendedNextStep === "retry_with_device_token";
    const canRetryWithDeviceTokenHint =
      recoveryAdvice.canRetryWithDeviceToken === true ||
      retryWithDeviceTokenRecommended ||
      connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH;

    if (
      shouldRetryWithDeviceToken({
        deviceTokenRetryBudgetUsed: this.deviceTokenRetryBudgetUsed,
        authDeviceToken: plan.selectedAuth.authDeviceToken,
        explicitGatewayToken: plan.explicitGatewayToken,
        deviceIdentity: plan.deviceIdentity,
        storedToken: plan.selectedAuth.storedToken,
        canRetryWithDeviceTokenHint,
        url: this.opts.url,
      })
    ) {
      this.pendingDeviceTokenRetry = true;
      this.deviceTokenRetryBudgetUsed = true;
    }
    if (err instanceof GatewayRequestError) {
      this.pendingConnectError = {
        code: err.gatewayCode,
        message: err.message,
        details: err.details,
        retryable: err.retryable,
        retryAfterMs: err.retryAfterMs,
      };
    } else {
      this.pendingConnectError = undefined;
    }
    const usedStoredDeviceToken =
      Boolean(plan.selectedAuth.storedToken) &&
      (plan.selectedAuth.resolvedDeviceToken === plan.selectedAuth.storedToken ||
        plan.selectedAuth.authDeviceToken === plan.selectedAuth.storedToken);
    if (
      usedStoredDeviceToken &&
      plan.deviceIdentity &&
      connectErrorCode === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH
    ) {
      clearDeviceAuthToken({ deviceId: plan.deviceIdentity.deviceId, role: plan.role });
    }
    const startupRetryAfterMs = resolveGatewayStartupRetryAfterMs(err);
    if (startupRetryAfterMs !== null) {
      this.pendingStartupReconnectDelayMs = startupRetryAfterMs;
    }
    if (isRetryableGatewayStartupUnavailableError(err)) {
      ws.close(STARTUP_RETRY_CLOSE_CODE, "gateway starting");
      return;
    }
    ws.close(CONNECT_FAILED_CLOSE_CODE, "connect failed");
  }

  private isActiveSocket(ws: WebSocket, generation: number): boolean {
    return !this.closed && this.ws === ws && this.connectGeneration === generation;
  }

  private async sendConnect(ws: WebSocket, generation: number) {
    if (!this.isActiveSocket(ws, generation) || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.connectSent) {
      return;
    }
    this.connectSent = true;
    this.clearConnectTimer();

    const plan = await this.buildConnectPlan(this.connectNonce);
    if (!this.isActiveSocket(ws, generation) || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.pendingDeviceTokenRetry && plan.selectedAuth.authDeviceToken) {
      this.pendingDeviceTokenRetry = false;
    }
    void this.requestOnSocket<GatewayHelloOk>(ws, "connect", this.buildConnectParams(plan))
      .then((hello) => this.handleConnectHello(hello, plan, ws, generation))
      .catch((err: unknown) => this.handleConnectFailure(err, plan, ws, generation));
  }

  private handleMessage(ws: WebSocket, generation: number, raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown; sentAt?: unknown };
    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: unknown } | undefined;
        const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          void this.sendConnect(ws, generation);
        }
        return;
      }
      this.captureRxSample(frame.sentAt, "event", undefined, evt.event);
      if (evt.event === "ping.gw-to-peer") {
        this.handlePingGwToPeerEvent(evt.payload);
      }
      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = seq;
      }
      try {
        this.opts.onEvent?.(evt);
        for (const listener of this.eventListeners) {
          listener(evt);
        }
      } catch (err) {
        console.error("[gateway] event handler error:", err);
      }
      return;
    }

    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) {
        return;
      }
      this.captureRxSample(frame.sentAt, "res", pending.method, undefined);
      this.pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(
          new GatewayRequestError({
            code: res.error?.code ?? "UNAVAILABLE",
            message: res.error?.message ?? "request failed",
            details: res.error?.details,
            retryable: res.error?.retryable,
            retryAfterMs: res.error?.retryAfterMs,
          }),
        );
      }
      return;
    }
  }

  private selectConnectAuth(params: { role: string; deviceId: string }): SelectedConnectAuth {
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const authPassword = this.opts.password?.trim() || undefined;
    const storedEntry = loadDeviceAuthToken({
      deviceId: params.deviceId,
      role: params.role,
    });
    const storedScopes = storedEntry?.scopes ?? [];
    const storedTokenCanRead =
      params.role !== CONTROL_UI_OPERATOR_ROLE ||
      storedScopes.includes("operator.read") ||
      storedScopes.includes("operator.write") ||
      storedScopes.includes("operator.admin");
    const storedToken = storedTokenCanRead ? storedEntry?.token : undefined;
    const shouldUseDeviceRetryToken =
      this.pendingDeviceTokenRetry &&
      Boolean(explicitGatewayToken) &&
      Boolean(storedToken) &&
      isTrustedRetryEndpoint(this.opts.url);
    const resolvedDeviceToken = !(explicitGatewayToken || authPassword)
      ? (storedToken ?? undefined)
      : undefined;
    const authToken = explicitGatewayToken ?? resolvedDeviceToken;
    return {
      authToken,
      authDeviceToken: shouldUseDeviceRetryToken ? (storedToken ?? undefined) : undefined,
      authPassword,
      resolvedDeviceToken,
      storedToken: storedToken ?? undefined,
      canFallbackToShared: Boolean(storedToken && explicitGatewayToken),
    };
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    return this.requestOnSocket(this.ws, method, params);
  }

  private requestOnSocket<T = unknown>(
    ws: WebSocket,
    method: string,
    params?: unknown,
  ): Promise<T> {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = generateUUID();
    // Shift sentAt into the gateway's clock frame using the cached offset so
    // the gateway-side `oneWayLatencyMs = capturedAt - sentAt` stays accurate.
    // Before the first time.sync completes this is a no-op (offset = 0). The
    // offset can be a `.5` value from `((t1-t0)+(t2-t3))/2`; round so the
    // wire-level `sentAt` stays integer (`Type.Integer` rejects fractions).
    const frame = {
      type: "req",
      id,
      method,
      params,
      sentAt: Math.round(Date.now() + this.clockOffsetMs),
    };
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, method });
    });
    ws.send(JSON.stringify(frame));
    return p;
  }

  private captureRxSample(sentAt: unknown, kind: string, method?: string, event?: string) {
    if (typeof sentAt !== "number") {
      return;
    }
    const peerNow = Date.now();
    const adjustedTs = Math.round(peerNow + this.clockOffsetMs);
    const latencyMs = adjustedTs - sentAt;
    if (latencyMs < 0 || latencyMs >= 60_000) {
      return;
    }
    this.rxSamples.push({ ts: adjustedTs, latencyMs, kind, method, event });
    if (this.rxSamples.length > RX_REPORT_BUFFER_CAP) {
      this.rxSamples.splice(0, this.rxSamples.length - RX_REPORT_BUFFER_CAP);
    }
  }

  private startRxReportSchedule() {
    this.stopRxReportSchedule();
    this.rxReportTimer = window.setInterval(() => {
      void this.flushRxSamples();
    }, RX_REPORT_INTERVAL_MS);
  }

  private stopRxReportSchedule() {
    if (this.rxReportTimer !== null) {
      window.clearInterval(this.rxReportTimer);
      this.rxReportTimer = null;
    }
  }

  private startPingSchedule() {
    this.stopPingSchedule();
    this.pingTimer = window.setInterval(() => {
      void this.runPingCycle();
    }, PING_INTERVAL_MS);
  }

  private stopPingSchedule() {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private async runPingCycle(): Promise<void> {
    if (this.pingInFlight || this.closed) {
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.pingInFlight = true;
    try {
      const peerT0 = Date.now();
      const result = await this.request<{
        peerT0: number;
        gatewayProcessingMs: number;
      }>("ping.peer-to-gw", { peerT0 });
      const peerT3 = Date.now();
      if (result && typeof result.gatewayProcessingMs === "number") {
        const wireRttMs = Math.max(0, peerT3 - peerT0 - result.gatewayProcessingMs);
        // Forward (peer → gateway) one-way is half the round trip in this
        // direction. RTT was measured with a single peer clock so the value
        // is mechanically honest within this ping.
        const sample: PingOneWaySample = { ts: peerT3, oneWayMs: wireRttMs / 2 };
        await this.request("ping.metrics-report", { samples: [sample] }).catch(() => {
          // best-effort
        });
      }
    } catch {
      // Expected during reconnect/race; next 5s tick will retry.
    } finally {
      this.pingInFlight = false;
    }
  }

  private handlePingGwToPeerEvent(payload: unknown): void {
    const peerT1 = Date.now();
    if (!payload || typeof payload !== "object") {
      return;
    }
    const data = payload as { pingId?: unknown; gatewayT0?: unknown };
    if (typeof data.pingId !== "string" || typeof data.gatewayT0 !== "number") {
      return;
    }
    const pingId = data.pingId;
    const gatewayT0 = data.gatewayT0;
    const peerT2 = Date.now();
    void this.request("ping.gw-to-peer.ack", {
      pingId,
      gatewayT0,
      peerProcessingMs: Math.max(0, peerT2 - peerT1),
    }).catch(() => {
      // best-effort
    });
  }

  private async flushRxSamples(): Promise<void> {
    if (this.rxReportInFlight || this.closed) {
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.rxSamples.length === 0) {
      return;
    }
    const batch = this.rxSamples.splice(0);
    this.rxReportInFlight = true;
    try {
      await this.request("protocol-traces.rx-report", { samples: batch });
    } catch {
      // Telemetry only — drop on failure rather than building unbounded queue.
    } finally {
      this.rxReportInFlight = false;
    }
  }

  private startClockSyncSchedule() {
    this.stopClockSyncSchedule();
    void this.runClockSyncBurst();
    this.clockSyncTimer = window.setInterval(() => {
      if (this.closed) {
        return;
      }
      void this.runClockSyncBurst();
    }, TIME_SYNC_PERIODIC_INTERVAL_MS);
  }

  private stopClockSyncSchedule() {
    if (this.clockSyncTimer !== null) {
      window.clearInterval(this.clockSyncTimer);
      this.clockSyncTimer = null;
    }
  }

  private async runClockSyncBurst(): Promise<void> {
    if (this.clockSyncInFlight || this.closed) {
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.clockSyncInFlight = true;
    try {
      const samples: ClockSyncSample[] = [];
      let bestSoFar: ClockSyncSample | null = null;
      for (let i = 0; i < TIME_SYNC_BURST_SAMPLES; i++) {
        if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
          break;
        }
        try {
          const peerT0 = Date.now();
          const result = await this.request<TimeSyncResponse>("time.sync", {
            peerT0,
            prevSync: this.lastClockSyncMetrics ?? undefined,
          });
          const peerT3 = Date.now();
          if (
            result &&
            typeof result.gatewayT1 === "number" &&
            typeof result.gatewayT2 === "number"
          ) {
            const sample = computeClockSyncSample(
              peerT0,
              result.gatewayT1,
              result.gatewayT2,
              peerT3,
            );
            // Discard implausible samples (negative or absurdly long RTTs that
            // can only mean we caught a system suspend or wall-clock jump).
            if (sample.rttMs < 60_000) {
              samples.push(sample);
              // Update incrementally so the offset improves before the burst
              // finishes — early outbound frames get a usable offset within
              // ~one RTT instead of waiting ~one second for the full burst.
              if (!bestSoFar || sample.rttMs < bestSoFar.rttMs) {
                bestSoFar = sample;
                this.clockOffsetMs = sample.offsetMs;
                this.lastClockSyncMetrics = {
                  offsetMs: sample.offsetMs,
                  networkRttMs: sample.networkRttMs,
                  gatewayProcessingMs: sample.gatewayProcessingMs,
                };
              }
            }
          }
        } catch {
          // Expected during reconnect/race conditions; the next burst will
          // retry. Do not log to avoid console spam in the browser.
        }
        if (i < TIME_SYNC_BURST_SAMPLES - 1) {
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, TIME_SYNC_BURST_INTERVAL_MS),
          );
        }
      }
      const final = pickBestSample(samples);
      if (final) {
        this.clockOffsetMs = final.offsetMs;
        this.lastClockSyncMetrics = {
          offsetMs: final.offsetMs,
          networkRttMs: final.networkRttMs,
          gatewayProcessingMs: final.gatewayProcessingMs,
        };
      }
    } finally {
      this.clockSyncInFlight = false;
    }
  }

  addEventListener(listener: GatewayEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private queueConnect(ws: WebSocket, generation: number) {
    if (!this.isActiveSocket(ws, generation)) {
      return;
    }
    this.connectNonce = null;
    this.connectSent = false;
    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      void this.sendConnect(ws, generation);
    }, 750);
  }

  private clearConnectTimer() {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
}
