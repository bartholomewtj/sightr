// Copied from web/src/components/lock-prompt.tsx (same /api/lock endpoints), on web2's Button.
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { b64uToBytes, bytesToB64u, fetchLockStatus, unlockWebauthn, webauthnChallenge } from "@/lib/api";

function canUseDevice(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window;
}

export function LockPrompt({ onUnlocked }: { onUnlocked: () => void }) {
  const [deviceError, setDeviceError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [webauthn, setWebauthn] = useState(true);
  const [allow, setAllow] = useState<string[]>([]);

  useEffect(() => {
    fetchLockStatus()
      .then((s) => {
        setWebauthn(s.webauthn ?? true);
        setAllow(s.allowCredentials ?? []);
      })
      .catch(() => {});
  }, []);

  const can = webauthn && canUseDevice();

  async function device() {
    setBusy(true);
    setDeviceError(false);
    try {
      const opts = await webauthnChallenge("assert");
      const cred = (await navigator.credentials.get({
        publicKey: {
          challenge: b64uToBytes(opts.challenge) as BufferSource,
          rpId: opts.rpId,
          allowCredentials: (opts.allowCredentials.length ? opts.allowCredentials : allow).map((id) => ({
            type: "public-key" as const,
            id: b64uToBytes(id) as BufferSource,
          })),
          userVerification: "required",
          timeout: opts.timeout,
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw new Error("cancelled");
      const response = cred.response as AuthenticatorAssertionResponse;
      const result = await unlockWebauthn({
        id: cred.id,
        clientDataJSON: bytesToB64u(response.clientDataJSON),
        authenticatorData: bytesToB64u(response.authenticatorData),
        signature: bytesToB64u(response.signature),
      });
      if (result.ok) onUnlocked();
      else throw new Error("rejected");
    } catch {
      setDeviceError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 text-center pt-[max(env(safe-area-inset-top),1.5rem)] pb-[max(env(safe-area-inset-bottom),1.5rem)] pl-[max(env(safe-area-inset-left),1.5rem)] pr-[max(env(safe-area-inset-right),1.5rem)]">
      <h1 className="text-2xl font-semibold">Sightr is locked</h1>
      <p className="max-w-sm text-muted-foreground">
        {can
          ? "Unlock with this device to reconnect."
          : "This browser can't use device unlock. Add this device from a registered browser on HTTPS, or delete lock.json on the host."}
      </p>
      {can && (
        <Button disabled={busy} onClick={() => void device()}>
          {busy ? "Unlocking…" : "Unlock with this device"}
        </Button>
      )}
      {deviceError && <p className="text-destructive">Couldn't unlock with this device</p>}
    </main>
  );
}
