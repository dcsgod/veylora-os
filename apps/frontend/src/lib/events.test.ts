import { describe, expect, it } from "vitest";
import { SseParser } from "./events";

describe("SseParser", () => {
  it("parses frames split across chunks and ignores comments", () => {
    const p = new SseParser();
    expect(p.feed("retry: 2000\n\n: heartbeat\n\nid: 4\nevent: task.st")).toEqual([]);
    expect(p.feed('atus\ndata: {"id":4}\n\n')).toEqual([{ id: "4", event: "task.status", data: '{"id":4}' }]);
  });

  it("handles CRLF and multi-line data", () => {
    const p = new SseParser();
    expect(p.feed("id: 1\r\ndata: a\r\ndata: b\r\n\r\n")).toEqual([{ id: "1", event: null, data: "a\nb" }]);
  });

  it("keeps the last id across frames", () => {
    const p = new SseParser();
    const frames = p.feed("id: 7\ndata: x\n\ndata: y\n\n");
    expect(frames.map((f) => f.id)).toEqual(["7", "7"]);
  });
});
