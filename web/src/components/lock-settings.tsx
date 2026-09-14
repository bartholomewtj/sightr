import { useEffect, useState } from "react";
import { Lock } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  b64uToBytes,
  bytesToB64u,
  clearLock,
  fetchLockStatus,
  registerWebauthn,
  removeWebauthn,
  webauthnChallenge,
} from "@/lib/api";
import type { LockStatus } from "@/lib/types";

const guessName = () =>
  /iPhone|iPad/.test(navigator.userAgent)
    ? "iPhone"
    : /Android/.test(navigator.userAgent)
      ? "Android"
      : /Windows/.test(navigator.userAgent)
        ? "Windows"
        : "This browser";

function canUseDevice(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window;
}

export function LockSettings({ readOnly }: { readOnly: boolean }) {
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [error, setError] = useState("");
  const [lockConfirming, setLockConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localId, setLocalId] = useState<string | null>(() => {
    try {
      return localStorage.getItem("sightr.webauthn.id");
    } catch {
      return null;
    }
  });

  const load = () =>
    fetchLockStatus()
      .then((next) => {
        setStatus(next);
        const id = localId ?? (typeof localStorage !== "undefined" ? localStorage.getItem("sightr.webauthn.id") : null);
        if (id && !next.credentials?.some((c) => c.id === id)) {
          try {
            localStorage.removeItem("sightr.webauthn.id");
          } catch {
            /* ignore */
          }
          setLocalId(null);
        }
      })
      .catch(() => {});

  useEffect(() => {
    void load();
  }, []);

  const can = canUseDevice();
  const thisDeviceRegistered = Boolean(localId && status?.credentials?.some((c) => c.id === localId));

  async function add() {
    setBusy(true);
    setError("");
    try {
      const opts = await webauthnChallenge("register");
      const cred = (await navigator.credentials.create({
        publicKey: {
          rp: { id: opts.rpId, name: "Sightr" },
          user: { id: b64uToBytes(opts.userId) as BufferSource, name: "operator", displayName: "Sightr" },
          challenge: b64uToBytes(opts.challenge) as BufferSource,
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            residentKey: "preferred",
            userVerification: "required",
          },
          attestation: "none",
          timeout: opts.timeout,
          excludeCredentials: opts.allowCredentials.map((id) => ({
            type: "public-key" as const,
            id: b64uToBytes(id) as BufferSource,
          })),
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw new Error("cancelled");
      const response = cred.response as AuthenticatorAttestationResponse;
      const authenticatorData =
        typeof response.getAuthenticatorData === "function" ? bytesToB64u(response.getAuthenticatorData()) : "";
      await registerWebauthn({
        id: cred.id,
        clientDataJSON: bytesToB64u(response.clientDataJSON),
        authenticatorData,
        attestationObject: bytesToB64u(response.attestationObject),
        name: guessName(),
      });
      localStorage.setItem("sightr.webauthn.id", cred.id);
      setLocalId(cred.id);
      await load();
    } catch {
      setError("Couldn't add this device");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, isLocal: boolean) {
    await removeWebauthn(id);
    if (isLocal) {
      try {
        localStorage.removeItem("sightr.webauthn.id");
      } catch {
        /* ignore */
      }
      setLocalId(null);
    }
    await load();
  }

  if (!status) {
    return (
      <Card className="gap-0 py-0">
        <div className="p-4 text-sm text-muted-foreground">Loading…</div>
      </Card>
    );
  }

  return (
    <Card className="gap-0 py-0">
      <div className="p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Lock className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Reconnect lock</div>
            <p className="text-sm text-muted-foreground">
              {status.enabled
                ? "On — asked after a bridge restart, or 12 hours idle."
                : "Off — anyone who can reach Sightr gets straight in."}
            </p>
            {status.corrupt && (
              <p className="mt-1 text-sm text-status-blocked">
                Lock store was unreadable and has been set aside — register a device again.
              </p>
            )}
          </div>
        </div>

        {!status.enabled && can && (
          <div className="mt-3">
            <Button size="sm" variant="outline" disabled={readOnly || busy} onClick={() => void add()}>
              Add this device
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">Uses Face ID, Windows Hello, or this device's lock.</p>
          </div>
        )}

        {status.enabled && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm">This device</span>
              {thisDeviceRegistered ? (
                <Button size="sm" variant="outline" disabled={readOnly} onClick={() => void remove(localId!, true)}>
                  Remove this device
                </Button>
              ) : (
                can && (
                  <Button size="sm" variant="outline" disabled={readOnly || busy} onClick={() => void add()}>
                    Add this device
                  </Button>
                )
              )}
            </div>
            {(status.credentials ?? [])
              .filter((c) => c.id !== localId)
              .map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {c.name} · added {new Date(c.addedAt).toLocaleDateString()}
                  </span>
                  <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => void remove(c.id, false)}>
                    Remove
                  </Button>
                </div>
              ))}
            <Button
              size="sm"
              variant="outline"
              disabled={readOnly}
              onClick={() => {
                if (lockConfirming) {
                  void clearLock().then(() => {
                    setLockConfirming(false);
                    void load();
                  });
                } else setLockConfirming(true);
              }}
            >
              {lockConfirming ? "Confirm" : "Turn off reconnect lock"}
            </Button>
          </div>
        )}

        {!can && <p className="mt-3 text-xs text-muted-foreground">Device unlock needs HTTPS.</p>}
        {readOnly && <p className="mt-3 text-xs text-muted-foreground">This device isn't authorised to change settings.</p>}
        {error && <p className="mt-3 text-xs text-status-blocked">{error}</p>}
      </div>
    </Card>
  );
}
