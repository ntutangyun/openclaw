import { html, nothing, type TemplateResult } from "lit";
import type { ProtocolTraceRecord, CoalescedGroup } from "../controllers/protocol-monitor.ts";

function isCoalescedGroup(trace: ProtocolTraceRecord | CoalescedGroup): trace is CoalescedGroup {
  return "type" in trace && trace.type === "group";
}

export type ProtocolMonitorDetailProps = {
  trace: ProtocolTraceRecord | CoalescedGroup;
  onClose: () => void;
};

function formatTs(ts: number): string {
  return new Date(ts).toISOString();
}

function jsonBlock(value: unknown): TemplateResult {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return html`<pre
      style="
        margin:0;
        padding:8px;
        background:#f1f3f9;
        border-radius:4px;
        overflow-x:auto;
        font-size:11px;
        line-height:1.4;
        max-height:400px;
        overflow-y:auto;
        white-space:pre-wrap;
        word-break:break-all;
      "
    >
${text}</pre
    >`;
  } catch {
    return html`<pre style="margin:0;padding:8px;">${String(value)}</pre>`;
  }
}

function renderSingleTrace(trace: ProtocolTraceRecord): TemplateResult {
  return html`
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div class="pd-field">
        <span class="pd-label">Kind</span>
        <span>${trace.kind}</span>
      </div>
      <div class="pd-field">
        <span class="pd-label">Direction</span>
        <span>${trace.direction}</span>
      </div>
      <div class="pd-field">
        <span class="pd-label">Source</span>
        <span>${trace.source}</span>
      </div>
      <div class="pd-field">
        <span class="pd-label">Target</span>
        <span>${trace.target}</span>
      </div>
      ${trace.method
        ? html`<div class="pd-field">
            <span class="pd-label">Method</span>
            <span>${trace.method}</span>
          </div>`
        : nothing}
      ${trace.event
        ? html`<div class="pd-field">
            <span class="pd-label">Event</span>
            <span>${trace.event}</span>
          </div>`
        : nothing}
      ${trace.ok !== undefined
        ? html`<div class="pd-field">
            <span class="pd-label">OK</span>
            <span style="color:${trace.ok ? "#22c55e" : "#ef4444"}">${String(trace.ok)}</span>
          </div>`
        : nothing}
      ${trace.connId
        ? html`<div class="pd-field">
            <span class="pd-label">ConnId</span>
            <span style="font-size:10px;">${trace.connId}</span>
          </div>`
        : nothing}
      ${trace.runId
        ? html`<div class="pd-field">
            <span class="pd-label">RunId</span>
            <span style="font-size:10px;">${trace.runId}</span>
          </div>`
        : nothing}
      ${trace.stream
        ? html`<div class="pd-field">
            <span class="pd-label">Stream</span>
            <span>${trace.stream}</span>
          </div>`
        : nothing}
      <div class="pd-field">
        <span class="pd-label">Timestamp</span>
        <span style="font-size:10px;">${formatTs(trace.ts)}</span>
      </div>
      ${trace.payload !== undefined
        ? html`
            <div>
              <span class="pd-label">Payload</span>
              ${jsonBlock(trace.payload)}
            </div>
          `
        : nothing}
    </div>
  `;
}

export function renderProtocolMonitorDetail(props: ProtocolMonitorDetailProps): TemplateResult {
  const { trace, onClose } = props;
  const isGroup = isCoalescedGroup(trace);

  return html`
    <style>
      .pd-root {
        padding: 12px;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        color: #1a1a2e;
      }
      .pd-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }
      .pd-header h3 {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
      }
      .pd-close {
        background: none;
        border: none;
        color: #6b7280;
        cursor: pointer;
        font-size: 18px;
        padding: 0 4px;
        line-height: 1;
      }
      .pd-close:hover {
        color: #1a1a2e;
      }
      .pd-field {
        display: flex;
        gap: 8px;
        align-items: baseline;
      }
      .pd-label {
        color: #6b7280;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        min-width: 60px;
        flex-shrink: 0;
      }
      .pd-group-event {
        border: 1px solid #d4d8e8;
        border-radius: 4px;
        margin-bottom: 8px;
        overflow: hidden;
      }
      .pd-group-event-header {
        padding: 6px 8px;
        background: #f1f3f9;
        cursor: pointer;
        font-size: 11px;
        display: flex;
        justify-content: space-between;
        user-select: none;
      }
      .pd-group-event-header:hover {
        background: #e5e7eb;
      }
      .pd-group-event-body {
        padding: 8px;
        border-top: 1px solid #d4d8e8;
      }
    </style>

    <div class="pd-root">
      <div class="pd-header">
        <h3>${isGroup ? "Streaming Group" : "Message Detail"}</h3>
        <button class="pd-close" @click=${onClose}>&times;</button>
      </div>

      ${isGroup ? renderGroupDetail(trace) : renderSingleTrace(trace)}
    </div>
  `;
}

function renderGroupDetail(group: CoalescedGroup): TemplateResult {
  return html`
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div class="pd-field">
        <span class="pd-label">RunId</span>
        <span style="font-size:10px;">${group.runId}</span>
      </div>
      <div class="pd-field">
        <span class="pd-label">Events</span>
        <span>${group.events.length}</span>
      </div>
      <div class="pd-field">
        <span class="pd-label">Source</span>
        <span>${group.source} -> ${group.target}</span>
      </div>
      <div class="pd-field">
        <span class="pd-label">First</span>
        <span style="font-size:10px;">${formatTs(group.events[0]?.ts ?? group.ts)}</span>
      </div>
      <div class="pd-field">
        <span class="pd-label">Last</span>
        <span style="font-size:10px;"
          >${formatTs(group.events[group.events.length - 1]?.ts ?? group.ts)}</span
        >
      </div>
      <div style="margin-top:8px;">
        <span class="pd-label" style="display:block;margin-bottom:6px;">Individual Events</span>
        ${group.events.map(
          (evt, i) => html`
            <details class="pd-group-event">
              <summary class="pd-group-event-header">
                <span>#${i + 1} seq=${evt.seq ?? "?"}</span>
                <span style="color:var(--text-secondary,#71717a);font-size:10px;">
                  ${formatTs(evt.ts)}
                </span>
              </summary>
              <div class="pd-group-event-body">
                ${evt.payload !== undefined ? jsonBlock(evt.payload) : html`<em>No payload</em>`}
              </div>
            </details>
          `,
        )}
      </div>
    </div>
  `;
}
