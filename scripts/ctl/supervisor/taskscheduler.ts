import path from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import type { Supervisor } from "./index.ts";
import { stopAllBridges } from "../win-processes.ts";
export function formatCommandArgument(s:string):string { return /[\s"]/.test(s)?`"${s.replace(/(\\*)"/g,"$1$1\\\"").replace(/(\\+)$/g,"$1$1")}"`:s; }
export function taskSchedulerSupervisor(env:Record<string,string|undefined>,isAdmin:()=>boolean=()=>true):Supervisor {
 const name=env.SIGHTR_TASK_NAME??"herdr.sightr",q=name.replace(/'/g,"''");
 return {kind:"taskscheduler",
  async describe(r){const x=await r("powershell",["-NoProfile","-Command",`(Get-ScheduledTask -TaskName '${q}').State`]);return x.code===0?`Task Scheduler (${name}) - ${x.stdout.trim()||"Ready"}`:"not supervised"},
  async install(s,r){
   const v=path.join(s.paths.configDir,"exec-bridge.vbs"); await mkdir(s.paths.configDir,{recursive:true});
   // wscript hides a console host. Call powershell (not `bun run file.ts`), which forwards _exec-bridge
   // as real argv — `bun run <file> <verb>` from a single WshShell.Run string drops the verb.
   const windir=env.SystemRoot??process.env.SystemRoot??"C:\\Windows";
   const powershell=path.join(windir,"System32","WindowsPowerShell","v1.0","powershell.exe");
   const ps1=path.join(s.paths.pluginRoot,"contrib","windows","sightr-ctl.ps1");
   const inner=[powershell,"-WindowStyle","Hidden","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",ps1,"-TaskConfigDir",s.paths.configDir,"-TaskSocketPath",s.socket,"_exec-bridge"].map(formatCommandArgument).join(" ");
   await writeFile(v,["' Written by sightr-ctl; overwritten on each start.","Set sh = CreateObject(\"WScript.Shell\")",`WScript.Quit sh.Run("${inner.replace(/"/g,'""')}", 0, True)`].join("\r\n")+"\r\n","ascii");
   const level=(env.SIGHTR_TASK_RUN_LEVEL??"limited").toLowerCase();
   if(level!=="limited"&&level!=="highest")throw new Error("SIGHTR_TASK_RUN_LEVEL must be 'limited' or 'highest'");
   if(level==="highest"&&!isAdmin())throw new Error("SIGHTR_TASK_RUN_LEVEL=highest requires Administrator PowerShell");
   const body=`$a=New-ScheduledTaskAction -Execute \"$env:SystemRoot\\System32\\wscript.exe\" -Argument \"//nologo ${v}\"; $t=New-ScheduledTaskTrigger -AtLogOn; $p=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel ${level==="highest"?"Highest":"Limited"}; $s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable; Register-ScheduledTask -TaskName '${q}' -Action $a -Trigger $t -Principal $p -Settings $s -Force; Enable-ScheduledTask -TaskName '${q}'`;
   await r("powershell",["-NoProfile","-Command",body]);
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
