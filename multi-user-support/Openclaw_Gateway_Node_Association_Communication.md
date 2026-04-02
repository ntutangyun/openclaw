Gateway-Node Association in OpenClaw: Detailed Report

1. Core Concepts

Gateway: A WebSocket/HTTP server (src/gateway/server.impl.ts) that acts as the central hub for all OpenClaw operations —  
 routing messages, managing channels, and coordinating remote devices.

Node: A remote device (iOS, Android, macOS) running the OpenClaw client app that connects to the gateway with role: "node".  
 Nodes expose device capabilities (camera, screen capture, canvas, etc.) and execute commands dispatched by the gateway.

---

2. Identity & Configuration

Node-Side Identity (src/node-host/config.ts)

Each node stores its identity in ~/.openclaw/node.json:

type NodeHostConfig = {  
 nodeId: string // UUID, generated on first run  
 token: string // Pairing token (received after approval)  
 displayName: string // Human-readable name  
 gateway: { // How to reach the gateway  
 host: string  
 port: number  
 tls: boolean
}  
 }

Gateway-Side Identity (src/gateway/node-registry.ts:4-21)

The gateway tracks each connected node as a NodeSession:

type NodeSession = {  
 nodeId: string
connId: string // WebSocket connection ID
client: GatewayWsClient // WebSocket handle
displayName?: string  
 platform?: string // "ios", "android", "macos"
version?: string  
 coreVersion?: string
uiVersion?: string  
 deviceFamily?: string  
 modelIdentifier?: string
remoteIp?: string  
 caps: string[] // ["canvas", "screen", "camera", ...]
commands: string[] // Commands this node can execute  
 permissions?: Record<string, boolean>  
 connectedAtMs: number  
 }

---

3. Transport Layer

WebSocket Connection

- Server: src/gateway/server/ws-connection.ts — handles WebSocket upgrades
- Client: src/gateway/client.ts — reconnects with exponential backoff
- Default port: 18789
- Bind modes: loopback, lan, tailnet, custom, auto

Message Framing (src/gateway/protocol/schema/frames.ts)

All communication uses a JSON-RPC-style protocol over WebSocket:

┌────────────┬───────────────────────────────────────────┐  
 │ Frame Type │ Structure │
├────────────┼───────────────────────────────────────────┤
│ Request │ { type: "req", id, method, params } │
├────────────┼───────────────────────────────────────────┤
│ Response │ { type: "res", id, ok, payload?, error? } │  
 ├────────────┼───────────────────────────────────────────┤  
 │ Event │ { type: "event", event, payload?, seq? } │  
 └────────────┴───────────────────────────────────────────┘

Key constants (src/gateway/server-constants.ts):

- MAX_PAYLOAD_BYTES: 25 MB
- TICK_INTERVAL_MS: ~30 seconds (heartbeat)

---

4. Connection Handshake (src/gateway/server/ws-connection/message-handler.ts)

The handshake is a multi-step process:

Step 1 — Challenge (Gateway → Node)

Gateway sends immediately on WebSocket connect:  
 { "type": "event", "event": "connect.challenge", "payload": { "nonce": "...", "ts": 1234567890 } }

Step 2 — Connect Request (Node → Gateway)

Node responds with a connect RPC call containing ConnectParams:

{  
 minProtocol: number,
maxProtocol: number,  
 client: {  
 id: string, // e.g. "android-app-v1"  
 displayName: string, // e.g. "My Phone"  
 version: string,  
 platform: string, // "ios", "android", "macos"  
 mode: string, // "agent" or other  
 instanceId?: string  
 },  
 role: "node", // Critical: identifies this as a node  
 caps: ["canvas", "camera", "screen", ...],  
 commands: ["screen.capture", "camera.take", ...],  
 device: { // Cryptographic device identity
id: string,  
 publicKey: string,
signature: string,  
 signedAt: number,
nonce: string  
 },  
 auth: {
token?: string, // Pairing token (after first pairing)
bootstrapToken?: string,  
 deviceToken?: string,  
 password?: string  
 }  
 }

Step 3 — Protocol Negotiation (lines 370-385)

Gateway checks that the client's [minProtocol, maxProtocol] range overlaps with the server's supported version. On mismatch,
the connection is closed with "protocol mismatch".

Step 4 — Authentication (lines 467-668)

Multi-level auth in order:

1. Browser origin validation (for control UI connections)
2. Device signature verification — validates public key signature against the challenge nonce (2-minute clock skew tolerance)
3. Token/password authentication — validates pairing token, device token, or password
4. Role & scope authorization — checks that the claimed role and scopes are permitted

Step 5 — Registration (lines 991-1039)

If role === "node", the gateway registers the node:

const nodeSession = context.nodeRegistry.register(nextClient, { remoteIp })

This adds the node to the in-memory NodeRegistry, records metadata (platform, caps, commands), and returns a HelloOk response
with server info and state snapshot.

---

5. Pairing System (src/infra/node-pairing.ts)

Pairing is the persistent trust relationship between a node and the gateway. It survives restarts (unlike the in-memory
NodeRegistry).

Storage

┌────────────────────────────────┬──────────────────────────────────────┐  
 │ File │ Purpose │
├────────────────────────────────┼──────────────────────────────────────┤  
 │ ~/.openclaw/nodes/pending.json │ Pending pairing requests (5-min TTL) │
├────────────────────────────────┼──────────────────────────────────────┤
│ ~/.openclaw/nodes/paired.json │ Approved nodes with tokens │  
 └────────────────────────────────┴──────────────────────────────────────┘

Paths resolved by src/infra/pairing-files.ts.

Data Types

Pending Request (lines 28-46):  
 type NodePairingPendingRequest = {
requestId: string  
 nodeId: string  
 displayName?: string
platform?: string  
 version?: string
caps?: string[]
commands?: string[]
permissions?: Record<string, boolean>  
 silent?: boolean // Auto-approve for local network
isRepair?: boolean // Re-pairing existing node  
 ts: number  
 }

Paired Node (lines 35-41):  
 type NodePairingPairedNode = {  
 nodeId: string  
 token: string // Secure pairing token  
 displayName?: string  
 platform?: string  
 createdAtMs: number
approvedAtMs: number  
 lastConnectedAtMs?: number
}

Pairing Flow

Node Gateway Operator  
 │ │ │  
 │── node.pair.request ────────>│ │  
 │ (nodeId, platform, caps) │── broadcast ─────────────────>│  
 │ │ "node.pair.requested" │  
 │ │ │  
 │ │<── node.pair.approve ─────────│  
 │ │ (requestId) │  
 │ │ │
│<── "node.pair.resolved" ─────│── broadcast ─────────────────>│  
 │ decision="approved" │ "node.pair.resolved" │  
 │ + pairing token │ │  
 │ │ │  
 │── node.pair.verify ─────────>│ (confirms token valid) │  
 │<── { ok: true } ────────────│ │

Silent pairing: When silent: true (local network connections), the gateway auto-approves without operator intervention.

RPC Methods (src/gateway/server-methods/nodes.ts)

┌───────────────────┬──────┬─────────────────────────────┐  
 │ Method │ Line │ Purpose │
├───────────────────┼──────┼─────────────────────────────┤  
 │ node.pair.request │ 461 │ Node initiates pairing │
├───────────────────┼──────┼─────────────────────────────┤
│ node.pair.list │ 495 │ List pending + paired nodes │  
 ├───────────────────┼──────┼─────────────────────────────┤  
 │ node.pair.approve │ 509 │ Operator approves request │  
 ├───────────────────┼──────┼─────────────────────────────┤  
 │ node.pair.reject │ 538 │ Operator rejects request │
├───────────────────┼──────┼─────────────────────────────┤  
 │ node.pair.verify │ 567 │ Node verifies its token │
├───────────────────┼──────┼─────────────────────────────┤  
 │ node.rename │ 585 │ Update display name │
└───────────────────┴──────┴─────────────────────────────┘

Authorization Scopes (src/gateway/method-scopes.ts)

- Pairing methods require operator.pairing scope
- Read methods (node.list, node.describe) require operator.read
- Invoke methods require operator.write

---

6. Node Registry (src/gateway/node-registry.ts)

The NodeRegistry is the in-memory store of currently connected nodes. It is distinct from the persistent pairing store.

Data Structures

class NodeRegistry {
nodesById: Map<string, NodeSession> // nodeId → session  
 nodesByConn: Map<string, string> // connId → nodeId  
 pendingInvokes: Map<string, PendingInvoke> // requestId → pending RPC  
 }

Key Methods

┌───────────────────────────────────┬─────────┬──────────────────────────────────────────────┐
│ Method │ Line │ Purpose │
├───────────────────────────────────┼─────────┼──────────────────────────────────────────────┤
│ register(client, opts) │ 43-79 │ Add node on connect │
├───────────────────────────────────┼─────────┼──────────────────────────────────────────────┤
│ unregister(connId) │ 81-97 │ Remove on disconnect, reject pending invokes │  
 ├───────────────────────────────────┼─────────┼──────────────────────────────────────────────┤  
 │ get(nodeId) │ 103 │ Look up by nodeId │  
 ├───────────────────────────────────┼─────────┼──────────────────────────────────────────────┤  
 │ listConnected() │ 99 │ All connected nodes │
├───────────────────────────────────┼─────────┼──────────────────────────────────────────────┤  
 │ invoke(params) │ 107-155 │ Send RPC to node (30s default timeout) │
├───────────────────────────────────┼─────────┼──────────────────────────────────────────────┤  
 │ handleInvokeResult(params) │ 157-181 │ Resolve pending invoke │
├───────────────────────────────────┼─────────┼──────────────────────────────────────────────┤  
 │ sendEvent(nodeId, event, payload) │ 183-189 │ Push event to node │
└───────────────────────────────────┴─────────┴──────────────────────────────────────────────┘

Lifecycle

- On connect: register() creates a NodeSession, updates lastConnectedAtMs in the pairing store
- On disconnect: unregister() removes the session and rejects all pending invokes for that node
- On gateway restart: registry is empty; nodes must reconnect

---

7. Command Invocation (src/gateway/server-methods/nodes.ts:852+)

Request Flow

Operator/Agent Gateway Node
│ │ │  
 │── node.invoke ───────────>│ │  
 │ (nodeId, command, │ │  
 │ params, timeoutMs) │ │  
 │ │── allowlist check ──> │  
 │ │── "node.invoke.request" ────>│  
 │ │ (id, command, params) │  
 │ │ │── execute  
 │ │<── "node.invoke.result" ─────│  
 │ │ (id, ok, payload/error) │  
 │<── response ──────────────│ │

Validation Steps

1. Node must be connected (or wakeable via APNS for iOS)
2. Command must be in node's declared commands list
3. Command must pass allowlist (src/gateway/node-command-policy.ts):  
   const allowlist = resolveNodeCommandAllowlist(cfg, nodeSession)  
   const allowed = isNodeCommandAllowed({ command, declaredCommands, allowlist })
4. Parameters sanitized via sanitizeNodeInvokeParamsForForwarding()

Wake Support (iOS, lines 900-972)

If the target node is offline:

1. Gateway sends APNS push notification to wake the iOS app
2. Waits NODE_WAKE_RECONNECT_WAIT_MS (3 seconds)
3. Retries with force flag if still disconnected
4. Sends wake nudge (throttled to NODE_WAKE_THROTTLE_MS = 15 seconds)

APNS token registration: src/infra/push-apns.ts

Pending Work Queue (src/gateway/node-pending-work.ts)

For offline nodes that can't be woken:

type NodePendingWork = {  
 type: "status.request" | "location.request"
priority: "normal" | "high"  
 expiresAtMs?: number // 10 minutes default  
 payload?: Record<string, unknown>  
 }

┌──────────────────────┬──────────────────────────────────────────┐  
 │ Method │ Purpose │  
 ├──────────────────────┼──────────────────────────────────────────┤  
 │ node.pending.enqueue │ Gateway queues work │
├──────────────────────┼──────────────────────────────────────────┤
│ node.pending.pull │ Node polls for pending work on reconnect │  
 ├──────────────────────┼──────────────────────────────────────────┤
│ node.pending.ack │ Node acknowledges completed work │  
 └──────────────────────┴──────────────────────────────────────────┘

Max 10 items per drain, sorted by priority.

---

8. Node Discovery

Bonjour/mDNS (src/infra/bonjour-discovery.ts)

Nodes on the local network can be discovered via Bonjour service advertisement, enabling automatic gateway URL resolution  
 without manual configuration.

---

9. Heartbeat & Presence

Tick Events

The gateway sends periodic tick events (~30s interval):  
 { "type": "event", "event": "tick", "payload": { "ts": 1234567890 } }

Clients track lastTick to detect silent connection stalls. If no tick is received within the timeout window, the client  
 triggers reconnection.

Presence Broadcasting (src/gateway/server-broadcast.ts)

The gateway broadcasts system-presence events to operators when nodes connect/disconnect, enabling real-time UI updates in  
 the control panel.

---

10. Node Event Handling (src/gateway/server-node-events.ts)

Nodes can push events to the gateway (not just respond to invocations):

┌──────────────────────────────────┬──────────────────────────────────┐
│ Event │ Purpose │  
 ├──────────────────────────────────┼──────────────────────────────────┤  
 │ voice.transcript │ Voice input from node microphone │
├──────────────────────────────────┼──────────────────────────────────┤  
 │ agent.request │ Node requests agent invocation │  
 ├──────────────────────────────────┼──────────────────────────────────┤  
 │ notifications.changed │ Notification state update │  
 ├──────────────────────────────────┼──────────────────────────────────┤  
 │ chat.subscribe / unsubscribe │ Subscribe to chat session │
├──────────────────────────────────┼──────────────────────────────────┤  
 │ exec.started / finished / denied │ Command execution lifecycle │
├──────────────────────────────────┼──────────────────────────────────┤  
 │ push.apns.register │ Register iOS push token │
└──────────────────────────────────┴──────────────────────────────────┘

These are routed by the event handler (lines 256-627) to appropriate subsystems (agent dispatch, session manager, etc.).

---

11. Node Subscription Manager (src/gateway/server-node-subscriptions.ts)

Tracks which nodes are subscribed to which chat sessions, enabling:

- Routing chat events to interested nodes
- Cleanup on node disconnect via context.nodeUnsubscribeAll(nodeId)

---

12. Security & Rate Limiting

┌─────────────────┬────────────────────────────────────────────────────────────┬─────────────────────────────────────────┐
│ Layer │ File │ Purpose │  
 ├─────────────────┼────────────────────────────────────────────────────────────┼─────────────────────────────────────────┤
│ Auth rate │ src/gateway/auth-rate-limit.ts │ Per-IP rate limit on failed auth │  
 │ limiting │ │ │
├─────────────────┼────────────────────────────────────────────────────────────┼─────────────────────────────────────────┤  
 │ Origin checking │ src/gateway/origin-check.ts │ CORS validation for control UI │  
 ├─────────────────┼────────────────────────────────────────────────────────────┼─────────────────────────────────────────┤  
 │ Device auth │ src/gateway/server/ws-connection/handshake-auth-helpers.ts │ Public key signature verification │  
 ├─────────────────┼────────────────────────────────────────────────────────────┼─────────────────────────────────────────┤
│ Canvas JWT │ src/gateway/canvas-capability.ts │ Temporary tokens for canvas access │  
 │ │ │ (10-min TTL) │
└─────────────────┴────────────────────────────────────────────────────────────┴─────────────────────────────────────────┘

---

13. CLI Commands (src/cli/nodes-cli/)

openclaw nodes pending # List pending pairing requests
openclaw nodes approve <requestId> # Approve a pairing request  
 openclaw nodes reject <requestId> # Reject a pairing request  
 openclaw nodes rename --node <id> --name <name> # Rename a node  
 openclaw nodes list # List all nodes (connected + paired)  
 openclaw nodes describe <nodeId> # Get detailed node info  
 openclaw nodes invoke # Execute a command on a node

---

14. Complete Association Lifecycle

┌─────────────────────────────────────────────────────────────────┐
│ FIRST-TIME ASSOCIATION │  
 ├─────────────────────────────────────────────────────────────────┤  
 │ │  
 │ 1. Node discovers gateway (Bonjour or manual config) │  
 │ 2. Node opens WebSocket to gateway:18789 │  
 │ 3. Gateway sends connect.challenge with nonce │  
 │ 4. Node sends connect { role:"node", device:{sig}, caps } │  
 │ 5. Gateway validates protocol version │  
 │ 6. Gateway validates device signature │  
 │ 7. Node is unpaired → calls node.pair.request │  
 │ 8. Request stored in pending.json (5-min TTL) │  
 │ 9. Gateway broadcasts "node.pair.requested" to operators │  
 │ 10. Operator approves → generatePairingToken() │  
 │ 11. Token stored in paired.json │  
 │ 12. Gateway broadcasts "node.pair.resolved" (approved + token) │  
 │ 13. Node stores token in ~/.openclaw/node.json │  
 │ 14. Node registered in NodeRegistry (in-memory) │  
 │ 15. Gateway sends HelloOk with features + state snapshot │  
 │ │  
 ├─────────────────────────────────────────────────────────────────┤  
 │ SUBSEQUENT CONNECTIONS │
├─────────────────────────────────────────────────────────────────┤  
 │ │  
 │ 1. Node opens WebSocket, receives challenge │  
 │ 2. Node sends connect with auth.token (saved pairing token) │  
 │ 3. Gateway verifies token against paired.json │  
 │ 4. Node registered in NodeRegistry │  
 │ 5. lastConnectedAtMs updated in paired.json │  
 │ 6. Gateway sends HelloOk │  
 │ 7. Node polls node.pending.pull for queued work │
│ │  
 ├─────────────────────────────────────────────────────────────────┤
│ ACTIVE OPERATION │  
 ├─────────────────────────────────────────────────────────────────┤  
 │ │
│ • Gateway invokes commands via node.invoke → node executes │  
 │ • Node pushes events (voice, agent requests, notifications) │  
 │ • Heartbeat ticks every ~30s detect stale connections │  
 │ • On disconnect: NodeRegistry.unregister(), pending rejected │  
 │ • If offline: APNS wake (iOS) or pending work queue │  
 │ │  
 └─────────────────────────────────────────────────────────────────┘

---

15. Key Files Reference

┌─────────────────────────────────────────────────────┬─────────────────────────────────────────────┐
│ File │ Purpose │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/server.impl.ts │ Gateway server entry point │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/server/ws-connection.ts │ WebSocket connection handler │  
 ├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/server/ws-connection/message-handler.ts │ Handshake & RPC dispatch (~1150 lines) │  
 ├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/node-registry.ts │ In-memory node session tracking │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/infra/node-pairing.ts │ Persistent pairing state (pending + paired) │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/infra/pairing-files.ts │ Filesystem storage for pairing data │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/server-methods/nodes.ts │ All node RPC method handlers │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/server-node-events.ts │ Inbound node event routing │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/node-pending-work.ts │ Offline work queue │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/node-command-policy.ts │ Command allowlist enforcement │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/protocol/schema/frames.ts │ Protocol frame definitions │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/protocol/schema/nodes.ts │ Node method schemas │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/client.ts │ Client-side gateway connection │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/node-host/config.ts │ Node-side config storage │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/method-scopes.ts │ Authorization scope definitions │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/server-constants.ts │ Protocol constants (timeouts, limits) │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/auth-rate-limit.ts │ Auth rate limiting │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/infra/bonjour-discovery.ts │ Local network node discovery │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/infra/push-apns.ts │ iOS push notification registration │
├─────────────────────────────────────────────────────┼─────────────────────────────────────────────┤  
 │ src/gateway/server-node-subscriptions.ts │ Node chat session subscriptions │
└─────────────────────────────────────────────────────┴─────────────────────────────────────────────┘
