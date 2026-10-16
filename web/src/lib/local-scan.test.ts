import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { readLastScan, scanLocalServers } from "./local-scan";

const local = { host: "host.example", servers: [{ port: 3080, name: "local models" }] };

describe("local-scan store", () => {
  it("starts empty, then remembers a successful scan with its time", async () => {
    expect(readLastScan()).toBeUndefined();
    server.use(http.get("/api/local-servers", () => HttpResponse.json(local)));
    const before = Date.now();
    const scan = await scanLocalServers();
    expect(scan.host).toBe("host.example");
    expect(scan.servers).toEqual(local.servers);
    expect(scan.at).toBeGreaterThanOrEqual(before);
    expect(readLastScan()).toEqual(scan);
  });

  it("throws on a failed scan and keeps the previous one", async () => {
    server.use(http.get("/api/local-servers", () => HttpResponse.json(local)));
    const good = await scanLocalServers();
    server.use(http.get("/api/local-servers", () => new HttpResponse(null, { status: 500 })));
    await expect(scanLocalServers()).rejects.toBeInstanceOf(Error);
    expect(readLastScan()).toEqual(good);
  });

  it("ignores a corrupt stored value", () => {
    localStorage.setItem("sightr.local-scan", "{not json");
    expect(readLastScan()).toBeUndefined();
    localStorage.setItem("sightr.local-scan", JSON.stringify({ host: 1 }));
    expect(readLastScan()).toBeUndefined();
  });
});
