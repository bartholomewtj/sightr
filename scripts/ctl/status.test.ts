import { expect, test } from "bun:test";
import { herdrFromSnapshot, probeHerdr, renderStatus, snapshotProbeHeaders } from "./status.ts";
import { selectSupervisor } from "./supervisor/index.ts";
import { inboundBlocked } from "./tailscale.ts";

test("renders shared running banner and ACL warning",()=>{const out=renderStatus({ready:true,herdrReady:true,service:'Task Scheduler (herdr.sightr) - Running',version:'0.90.0+abc',port:8787,skipServe:false,url:'https://sightr.example',blocked:true}); expect(out).toContain('✓ Sightr is running'); expect(out).toContain('tailnet'); expect(out).toContain('packet filter'); expect(out).toContain('login.tailscale.com/admin/acls');});
test("renders unverified and proxy states",()=>{const out=renderStatus({ready:false,herdrReady:false,service:'not supervised',version:'unknown',port:8787,skipServe:false,url:'http://127.0.0.1:8787',blocked:false}); expect(out).toContain("isn't answering on"); expect(out).toContain('unverified'); expect(out).toContain('unverified');});
test("renders skip serve proxy",()=>{const out=renderStatus({ready:true,herdrReady:true,service:'not supervised',version:'unknown',port:8787,skipServe:true,publicUrl:'https://proxy.example',url:'https://proxy.example',blocked:false});expect(out).toContain('proxy     https://proxy.example');expect(out).toContain('serve config: skipped');});

test("the Task Scheduler supervisor reports its actual state", async () => {
 const commands:string[]=[]; const run=async (cmd:string,args:string[]) => { commands.push(`${cmd} ${args.join(" ")}`); return {code:0,stdout:"Ready\n",stderr:""}; };
 const task=selectSupervisor({}); expect(task.kind).toBe("taskscheduler"); expect(await task.describe(run)).toBe("Task Scheduler (herdr.sightr) - Ready"); expect(commands.some(x => x.includes("State"))).toBe(true); expect(await task.describe(async()=>({code:1,stdout:"",stderr:""}))).toBe("not supervised"); expect(await task.describe(async()=>({code:0,stdout:"",stderr:""}))).toContain("NOT REGISTERED");
 expect(await selectSupervisor({SIGHTR_TASK_NAME:"custom"}).describe(run)).toBe("Task Scheduler (custom) - Ready");
});
test("ACL uncertainty is silent and empty filters are blocked", async () => { const run=async (_c:string,_a:string[])=>({code:0,stdout:'{"PacketFilter":[]}',stderr:""}); expect(await inboundBlocked(run)).toBe(true); const out=renderStatus({ready:true,herdrReady:true,service:"x",version:"x",port:1,skipServe:false,url:"https://x",blocked:true}); expect(out).toContain("admits no peer"); expect(out).toContain("(unreachable from other devices)"); expect(out).toContain("login.tailscale.com/admin/acls"); expect(out).toContain("https://x"); for(const result of [{code:0,stdout:'{"PacketFilter":[1]}',stderr:""},{code:1,stdout:"",stderr:""},{code:0,stdout:"bad",stderr:""},{code:0,stdout:'{}',stderr:""},{code:0,stdout:'{"PacketFilter":null}',stderr:""}]) expect(await inboundBlocked(async()=>result)).toBe(false); const plain=renderStatus({ready:true,herdrReady:true,service:"x",version:"x",port:1,skipServe:false,url:"https://x",blocked:false}); expect(plain).not.toContain("admits no peer"); });
test("reports a running port that cannot reach Herdr",()=>expect(renderStatus({ready:true,herdrReady:false,service:"x",version:"x",port:1,skipServe:false,url:"https://x",blocked:false})).toContain("running but cannot reach Herdr"));

test("identity and lock refusals are not a Herdr outage", () => {
  expect(herdrFromSnapshot(403)).toBe(true);
  expect(herdrFromSnapshot(401)).toBe(true);
  expect(herdrFromSnapshot(200, { bridge: "connected" })).toBe(true);
  expect(herdrFromSnapshot(200, { bridge: "disconnected" })).toBe(false);
  expect(herdrFromSnapshot(200, {})).toBe(false);
  expect(herdrFromSnapshot(500)).toBe(false);
});

test("loopback snapshot probe sends the configured identity header", () => {
  expect(snapshotProbeHeaders({ SIGHTR_TRUSTED_USER: "you@example.com" })).toEqual({ "Tailscale-User-Login": "you@example.com" });
  expect(snapshotProbeHeaders({})).toEqual({});
  expect(snapshotProbeHeaders({ SIGHTR_TRUSTED_USER: "  " })).toEqual({});
});

test("probeHerdr treats an identity-gate 403 as Herdr still reachable", async () => {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const get = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers });
    return new Response("identity required", { status: 403 });
  };
  expect(await probeHerdr(8787, { SIGHTR_TRUSTED_USER: "you@example.com" }, get)).toBe(true);
  expect(calls[0]?.url).toBe("http://127.0.0.1:8787/api/snapshot");
  expect(calls[0]?.headers?.["Tailscale-User-Login"]).toBe("you@example.com");
});

test("probeHerdr still reports a real Herdr disconnect from snapshot JSON", async () => {
  const get = async () => new Response(JSON.stringify({ bridge: "disconnected" }), { status: 200 });
  expect(await probeHerdr(1, { SIGHTR_TRUSTED_USER: "you@example.com" }, get)).toBe(false);
  const connected = async () => new Response(JSON.stringify({ bridge: "connected" }), { status: 200 });
  expect(await probeHerdr(1, {}, connected)).toBe(true);
});
