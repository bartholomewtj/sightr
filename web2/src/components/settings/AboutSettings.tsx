// Settings → About: which build this is, whether the bridge now serves a newer one, and a button that
// goes and gets it. lib/pwa.ts already polls for a newer service worker every minute and reloads when
// one activates (holding the reload while a message is half typed); this row makes the same check
// something the operator can ask for, and shows the result in words. Read-only apart from that button.
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { checkForUpdate } from "@/lib/pwa";
import { useServerBuild } from "@/lib/server-build";
import { OpenSourceLicenses } from "./OpenSourceLicenses";
import { SettingsRow } from "./settingsLayout";

/** What the build ids say: `newer` when the bridge serves a web2 bundle other than the one running. */
export function updateState(running: string, server: string | undefined): "unknown" | "current" | "newer" {
  if (!server || server === "unknown" || running === "unknown") return "unknown";
  return server === running ? "current" : "newer";
}

export function AboutSettings() {
  const server = useServerBuild();
  const running = __BUILD_INFO__.id;
  const state = updateState(running, server);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      await checkForUpdate();
    } finally {
      setChecking(false);
      setChecked(true);
    }
  };

  return (
    <>
      <SettingsRow
        title="Sightr"
        description={`Version ${__BUILD_INFO__.version}, build ${running}.`}
        status={
          state === "newer"
            ? "A newer version is ready. Reload to use it."
            : checked
              ? "You are on the latest version."
              : state === "current"
                ? "You are on the version the bridge serves."
                : "Not checked yet."
        }
        control={
          state === "newer" ? (
            <Button size="sm" onClick={() => window.location.reload()}>
              <RefreshCwIcon />
              Reload to update
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
              <RefreshCwIcon />
              {checking ? "Checking…" : "Check for updates"}
            </Button>
          )
        }
      />
      <OpenSourceLicenses />
    </>
  );
}
