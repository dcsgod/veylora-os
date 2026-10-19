import type { VeyloraEvent } from "@veylora/contracts";
import { api } from "./api";

/** Incremental parser for the text/event-stream wire format. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private id: string | null = null;
  private event: string | null = null;

  feed(chunk: string): { id: string | null; event: string | null; data: string }[] {
    this.buffer += chunk;
    const out: { id: string | null; event: string | null; data: string }[] = [];
    let idx: number;
    while ((idx = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, idx);
      const sep = this.buffer.startsWith("\r\n", idx) ? 2 : 1;
      this.buffer = this.buffer.slice(idx + sep);
      if (line === "") {
        if (this.data.length) out.push({ id: this.id, event: this.event, data: this.data.join("\n") });
        this.data = [];
        this.event = null;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.data.push(value);
      else if (field === "id") this.id = value;
      else if (field === "event") this.event = value;
    }
    return out;
  }
}

export interface StreamHandle {
  close(): void;
}

/**
 * EventSource cannot send an Authorization header, so the stream is read with fetch.
 * Reconnects with Last-Event-ID so the backend replays anything missed while disconnected.
 */
export function openEventStream(onEvent: (e: VeyloraEvent) => void, onState: (connected: boolean) => void,
                                startAfter?: number): StreamHandle {
  let closed = false;
  let lastId = startAfter;
  let controller: AbortController | null = null;
  let delay = 1000;

  const loop = async () => {
    while (!closed) {
      controller = new AbortController();
      try {
        const res = await api.raw("/events", {
          signal: controller.signal,
          headers: lastId !== undefined ? { "Last-Event-ID": String(lastId) } : {},
        });
        if (!res.ok || !res.body) throw new Error(`stream failed with ${res.status}`);
        onState(true);
        delay = 1000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        const parser = new SseParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const frame of parser.feed(value)) {
            if (frame.id) lastId = Number(frame.id);
            try {
              onEvent(JSON.parse(frame.data) as VeyloraEvent);
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      } catch {
        /* reconnect below */
      }
      if (closed) break;
      onState(false);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  };
  void loop();
  return {
    close() {
      closed = true;
      controller?.abort();
    },
  };
}
