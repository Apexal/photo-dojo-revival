import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mediapipe/tasks-vision/vision_wasm_internal.js?url", () => ({ default: "/wasm.js" }));
vi.mock("@mediapipe/tasks-vision/vision_wasm_internal.wasm?url", () => ({ default: "/wasm.wasm" }));

const { DownloadTracker, loadModelBytes } = await import("../src/capture/vision-runtime");

afterEach(() => vi.unstubAllGlobals());

/** A response streamed in chunks, like a real download. */
function streamed(chunks: number[], contentLength = true): Response {
  const total = chunks.reduce((a, b) => a + b, 0);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const n of chunks) controller.enqueue(new Uint8Array(n).fill(7));
      controller.close();
    },
  });
  return new Response(body, { headers: contentLength ? { "content-length": String(total) } : {} });
}

describe("model downloads", () => {
  it("reports progress while streaming and returns the bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamed([100, 200, 700])));
    const seen: [number, number][] = [];
    const bytes = await loadModelBytes("https://example.test/model.task", (l, t) => seen.push([l, t]));
    expect(bytes.length).toBe(1000);
    expect(seen[0]).toEqual([0, 1000]);
    expect(seen).toContainEqual([300, 1000]);
    expect(seen.at(-1)).toEqual([1000, 1000]);
  });

  it("returns exactly the bytes sent when Content-Length is missing or wrong", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamed([100, 200, 700], false)));
    expect((await loadModelBytes("https://example.test/a")).length).toBe(1000);
    const short = streamed([100, 200]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(short.body, { headers: { "content-length": "250" } })));
    expect((await loadModelBytes("https://example.test/b")).length).toBe(300);
    const long = streamed([100, 200]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(long.body, { headers: { "content-length": "500" } })));
    const bytes = await loadModelBytes("https://example.test/c");
    expect(bytes.length).toBe(300);
    expect(bytes.every((b) => b === 7)).toBe(true);
  });

  it("uses the model cache when it has the file", async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (url: string) => store.get(url)?.clone(),
        put: async (url: string, r: Response) => { store.set(url, r); },
      }),
    });
    const fetchSpy = vi.fn(async () => streamed([10, 20]));
    vi.stubGlobal("fetch", fetchSpy);
    expect((await loadModelBytes("https://example.test/m")).length).toBe(30);
    expect((await loadModelBytes("https://example.test/m")).length).toBe(30);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fails clearly on an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(loadModelBytes("https://example.test/missing.task")).rejects.toThrow("missing.task (HTTP 404)");
  });

  it("combines downloads into one fraction, using estimates until sizes are known", () => {
    const fractions: number[] = [];
    const t = new DownloadTracker({ a: 100, b: 300 }, (f) => fractions.push(f));
    t.reporter("a")(50, 100);
    expect(t.fraction).toBeCloseTo(50 / 400);
    t.reporter("b")(0, 100); // real size smaller than the estimate
    t.reporter("a")(100, 100);
    t.reporter("b")(100, 100);
    expect(t.fraction).toBe(1);
  });
});
