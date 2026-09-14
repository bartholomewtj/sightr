import path from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import type { Supervisor } from "./index.ts";
import { stopAllBridges } from "../win-processes.ts";
import { CtlError } from "../types.ts";
export function formatCommandArgument(s:string):string { return /[\s"]/.test(s)?`"${s.replace(/(\\*)"/g,"$1$1\\\"").replace(/(\\+)$/g,"$1$1")}"`:s; }
export function taskSchedulerSupervisor(env:Record<string,string|undefined>,isAdmin:()=>boolean=()=>true):Supervisor {
 const name=env.SIGHTR_TASK_NAME??"herdr.sightr",q=name.replace(/'/g,"''");
 return {kind:"taskscheduler",
  async describe(r){const x=await r("powershell",["-NoProfile","-Command",`(Get-ScheduledTask -TaskName '${q}' -ErrorAction SilentlyContinue).State`]);if(x.code!==0)return "not supervised";const state=x.stdout.trim();return state?`Task Scheduler (${name}) - ${state}`:`Task Scheduler (${name}) - NOT REGISTERED (run start again; a registration error is printed when it fails)`},
  async install(s,r){
   const v=path.join(s.paths.configDir,"exec-bridge.vbs"); await mkdir(s.paths.configDir,{recursive:true});
   // wscript hides a console host. Call powershell (not `bun run file.ts`), which forwards _exec-bridge
   // as real argv — `bun run <file> <verb>` from a single WshShell.Run string drops the verb.
   const windir=env.SystemRoot??process.env.SystemRoot??"C:\\Windows";
   const powershell=path.join(windir,"System32","WindowsPowerShell","v1.0","powershell.exe");
   const ps1=path.join(s.paths.pluginRoot,"contrib","windows","sightr-ctl.ps1");
   // An unset socket path is OMITTED, not passed empty: the bridge defaults it to the platform
   // socket, and an empty argument would make the control script read "_exec-bridge" as the path.
   const inner=[powershell,"-WindowStyle","Hidden","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",ps1,"-TaskConfigDir",s.paths.configDir,...(s.socket?["-TaskSocketPath",s.socket]:[]),"_exec-bridge"].map(formatCommandArgument).join(" ");
   await writeFile(v,["' Written by sightr-ctl; overwritten on each start.","Set sh = CreateObject(\"WScript.Shell\")",`WScript.Quit sh.Run("${inner.replace(/"/g,'""')}", 0, True)`].join("\r\n")+"\r\n","ascii");
   const level=(env.SIGHTR_TASK_RUN_LEVEL??"limited").toLowerCase();
   if(level!=="limited"&&level!=="highest")throw new Error("SIGHTR_TASK_RUN_LEVEL must be 'limited' or 'highest'");
   if(level==="highest"&&!isAdmin())throw new Error("SIGHTR_TASK_RUN_LEVEL=highest requires Administrator PowerShell");
   const body=`$a=New-ScheduledTaskAction -Execute \"$env:SystemRoot\\System32\\wscript.exe\" -Argument \"//nologo ${v}\"; $t=New-ScheduledTaskTrigger -AtLogOn; $p=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel ${level==="highest"?"Highest":"Limited"}; $s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable; Register-ScheduledTask -TaskName '${q}' -Action $a -Trigger $t -Principal $p -Settings $s -Force; Enable-ScheduledTask -TaskName '${q}'`;
   const reg=await r("powershell",["-NoProfile","-Command",`$ErrorActionPreference='Stop'; ${body}; if (-not (Get-ScheduledTask -TaskName '${q}' -ErrorAction SilentlyContinue)) { throw 'task missing after Register-ScheduledTask' }`]);
   if(reg.code!==0){
    // Register-ScheduledTask -Force needs Administrator on some accounts even to re-register a task
    // the user already owns. A task that exists from an earlier (elevated) start still points at the
    // vbs just rewritten above, so keep it and let enableNow start it: `restart` from a normal shell
    // must not take the bridge down for good.
    const existing=await r("powershell",["-NoProfile","-Command",`(Get-ScheduledTask -TaskName '${q}' -ErrorAction SilentlyContinue).State`]);
    if(existing.code===0&&existing.stdout.trim()){
     console.error(`warn: could not re-register the scheduled task '${name}' (${((reg.stderr||reg.stdout).trim().split(/\r?\n/)[0]??"").trim()}); keeping the existing registration. Run start from an Administrator PowerShell if the task definition needs to change.`);
     return;
    }
    throw new CtlError(`error: could not register the scheduled task '${name}':
${(reg.stderr||reg.stdout).trim()}
       the bridge is not supervised; fix the cause and run start again`);
   }
  },
  async enableNow(s,r){
   await stopAllBridges({pluginRoot:s.paths.pluginRoot,vbsPath:path.join(s.paths.configDir,"exec-bridge.vbs"),processFile:path.join(s.paths.configDir,"sightr-processes"),port:s.port},r);
   await r("powershell",["-NoProfile","-Command",`Stop-ScheduledTask -TaskName '${q}' -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName '${q}'`]);
   console.log(`bridge started (Task Scheduler: ${name})`);
  },
  async disableNow(s,r){await r("powershell",["-NoProfile","-Command",`Disable-ScheduledTask -TaskName '${q}'`]);await stopAllBridges({pluginRoot:s.paths.pluginRoot,vbsPath:path.join(s.paths.configDir,"exec-bridge.vbs"),processFile:path.join(s.paths.configDir,"sightr-processes"),port:s.port},r);await r("powershell",["-NoProfile","-Command",`Stop-ScheduledTask -TaskName '${q}'`])},
  async remove(s,r){await r("powershell",["-NoProfile","-Command",`Unregister-ScheduledTask -TaskName '${q}' -Confirm:$false`]);await rm(path.join(s.paths.configDir,"exec-bridge.vbs"),{force:true})}
 };
}
