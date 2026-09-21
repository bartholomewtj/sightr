import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SightrMark } from "@/components/sightr-mark";
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
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <div className="text-center">
        <div className="mb-3 flex justify-center">
          <SightrMark className="size-20" />
        </div>
        <h1 className="text-2xl font-semibold">Sightr</h1>
        <p className="text-muted-foreground">
          {can
            ? "Unlock with this device to reconnect."
            : "This browser can't use device unlock. Add this device from a registered browser on HTTPS, or delete lock.json on the host."}
        </p>
      </div>
      {can && (
        <Button disabled={busy} onClick={() => void device()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : "Unlock with this device"}
        </Button>
      )}
      {deviceError && <p className="text-status-blocked">Couldn't unlock with this device</p>}
    </main>
  );
}
