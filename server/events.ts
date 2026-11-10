// Decision log shown in the merchant dashboard and printed by `npm run sim`.
import { JsonStore } from './store.ts';
import { rewrite } from './llm.ts';

export interface LogEvent {
  seq: number;
  ts: number;
  merchant: string;
  invoice_id?: number;
  kind: string;
  text: string;
  friendly?: string;
  tx?: string;
  tx_url?: string;
  data?: unknown;
}

export class EventLog {
  private store: JsonStore<{ events: LogEvent[] }>;
  private listeners: ((e: LogEvent) => void)[] = [];
  constructor(dir: string | null) {
    this.store = new JsonStore(dir, 'events', () => ({ events: [] }));
  }
  add(e: Omit<LogEvent, 'seq' | 'ts'>): LogEvent {
    const ev: LogEvent = { seq: this.store.data.events.length + 1, ts: Date.now(), ...e };
    this.store.data.events.push(ev);
    this.store.save();
    for (const l of this.listeners) l(ev);
    // Optional LLM rewording; the decision is already made and logged.
    rewrite(ev.text).then((f) => { if (f) { ev.friendly = f; this.store.save(); } });
    return ev;
  }
  onEvent(l: (e: LogEvent) => void) { this.listeners.push(l); }
  list(merchant?: string, since = 0): LogEvent[] {
    return this.store.data.events.filter((e) => e.seq > since && (!merchant || e.merchant === merchant));
  }
}
