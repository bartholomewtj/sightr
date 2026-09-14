import { build } from "./ctl/build.ts";
import { envCheck } from "./ctl/env-check.ts";
import { keys } from "./ctl/keys.ts";
import { status } from "./ctl/status.ts";
import { CtlError } from "./ctl/types.ts";
import { start, stop, restart, uninstall } from "./ctl/lifecycle.ts";
import { serve, unserve } from "./ctl/serve.ts";
import { bridgeUrl } from "./ctl/tailscale.ts";
import { execBridge } from "./ctl/exec-bridge.ts";
import { effectiveEnv } from "./ctl/env.ts";
import { getVersion } from "./ctl/version.ts";
import { update, applyUpdate } from "./ctl/update.ts";
import { hooks } from "./ctl/hooks.ts";
import { logs } from "./ctl/logs.ts";
import { qr } from "./ctl/qr.ts";
import { pushTest } from "./ctl/push-test.ts";
import { realRun } from "./ctl/types.ts";

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
 const verb=argv[0];
 if(verb==="build") return build();
 if(verb==="status") return status();
 if(verb==="env-check") return envCheck();
 if(verb==="keys"||verb==="push-keys") return keys(argv.slice(1));
 if(verb==="start") return start();
 if(verb==="stop") return stop();
 if(verb==="restart") return restart();
 if(verb==="serve") { const n=await serve(); if(n===0) console.log(`open: ${await bridgeUrl(process.env, (await import("./ctl/types.ts")).realRun)}`); return n; }
 if(verb==="unserve") return unserve();
 if(verb==="uninstall") return uninstall();
 if(verb==="_exec-bridge") return execBridge(argv.slice(1));
 if(verb==="update") return update(argv.slice(1));
 if(verb==="_apply-update") return applyUpdate();
 if(verb==="logs") return logs(argv.slice(1));
 if(verb==="hooks") return hooks(argv.slice(1));
 if(verb==="url") { const x=await effectiveEnv(process.env,realRun); console.log(await bridgeUrl(x.effective,realRun)); return 0; }
 if(verb==="qr") return qr();
 if(verb==="version") { const x=await effectiveEnv(process.env,realRun); console.log(await getVersion(x.paths)); return 0; }
 if(verb==="push-test") return pushTest(argv.slice(1));
 console.error("usage: bun scripts/ctl.ts {start|stop|restart|serve|unserve|uninstall|update|logs|hooks|url|qr|version|status|build|env-check|keys|push-keys|push-test}"); return 2;
}
if(import.meta.main) { try { process.exit(await main()); } catch(error) { if(error instanceof CtlError){console.error(error.message);process.exit(error.exitCode);} else {console.error(String(error));process.exit(1);} } }
