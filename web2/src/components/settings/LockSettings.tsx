// Copied from web/src/components/lock-settings.tsx (same `/api/lock/*` routes, same localStorage key for
// this device's credential, same origin), as settings rows. The reconnect lock: list, add (WebAuthn,
// a platform authenticator) and remove devices, or turn the lock off. A read-only device sees the list
// but none of the controls.
import { useEffect, useState } from "react";

import type { LockStatus } from "@shared/wire";
import { Button } from "~/components/ui/button";
import { b64uToBytes, bytesToB64u, clearLock, fetchLockStatus, registerWebauthn, removeWebauthn, webauthnChallenge } from "@/lib/api";
import { SettingsRow } from "./settingsLayout";

/** Where this browser remembers its own credential id (v1's key). */
export const LOCAL_CREDENTIAL_KEY = "sightr.webauthn.id";

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

function readLocalId(): string | null {
  try {
    return localStorage.getItem(LOCAL_CREDENTIAL_KEY);
  } catch {
    return null;
  }
}

function writeLocalId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LOCAL_CREDENTIAL_KEY);
    else localStorage.setItem(LOCAL_CREDENTIAL_KEY, id);
  } catch {
    /* private mode: this device just won't be marked */
  }
}

export function LockSettings({ readOnly }: { readOnly: boolean }) {
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [error, setError] = useState("");
  const [lockConfirming, setLockConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localId, setLocalId] = useState<string | null>(readLocalId);

  const load = () =>
    fetchLockStatus()
      .then((next) => {
        setStatus(next);
        const id = readLocalId();
        if (id && !next.credentials?.some((c) => c.id === id)) {
          writeLocalId(null);
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
          authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
          attestation: "none",
          timeout: opts.timeout,
          excludeCredentials: opts.allowCredentials.map((id) => ({ type: "public-key" as const, id: b64uToBytes(id) as BufferSource })),
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
      writeLocalId(cred.id);
      setLocalId(cred.id);
      await load();
    } catch {
      setError("Couldn't add this device");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, isLocal: boolean) {
    setError("");
    try {
      await removeWebauthn(id);
    } catch {
      setError("Couldn't remove that device");
      return;
    }
    if (isLocal) {
      writeLocalId(null);
      setLocalId(null);
    }
    await load();
  }

  if (!status) {
    return <SettingsRow title="Reconnect lock" description="Loading…" />;
  }

  const others = (status.credentials ?? []).filter((c) => c.id !== localId);

  return (
    <>
      <SettingsRow
        title="Reconnect lock"
        description={
          status.enabled
            ? "On — asked after a bridge restart, or 12 hours idle. All devices."
            : "Off — anyone who can reach Sightr gets straight in. All devices."
        }
        status={
          <>
            {status.corrupt ? (
              <span className="block text-destructive">Lock store was unreadable and has been set aside — register a device again.</span>
            ) : null}
            {!can ? <span className="block">Device unlock needs HTTPS.</span> : null}
            {readOnly ? <span className="block">This device isn't authorised to change settings.</span> : null}
            {error ? (
              <span role="alert" className="block text-destructive">
                {error}
              </span>
            ) : null}
          </>
        }
        control={
          status.enabled && !readOnly ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (lockConfirming) {
                  void clearLock()
                    .catch(() => setError("Couldn't turn the lock off"))
                    .then(() => {
                      setLockConfirming(false);
                      void load();
                    });
                } else setLockConfirming(true);
              }}
            >
              {lockConfirming ? "Confirm" : "Turn off reconnect lock"}
            </Button>
          ) : null
        }
      />
      <SettingsRow
        title="This device"
        description={
          thisDeviceRegistered
            ? "Registered. Unlocks with Face ID, Windows Hello or this device's lock."
            : status.enabled
              ? "Not registered. Add it to unlock from here."
              : "Add this device to turn the lock on. Uses Face ID, Windows Hello or this device's lock."
        }
        control={
          readOnly ? null : thisDeviceRegistered ? (
            <Button size="sm" variant="outline" onClick={() => void remove(localId!, true)}>
              Remove this device
            </Button>
          ) : can ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void add()}>
              Add this device
            </Button>
          ) : null
        }
      />
      {others.map((c) => (
        <SettingsRow
          key={c.id}
          data-lock-device={c.id}
          title={c.name}
          description={`Added ${new Date(c.addedAt).toLocaleDateString()}`}
          control={
            readOnly ? null : (
              <Button size="sm" variant="ghost" aria-label={`Remove ${c.name}`} onClick={() => void remove(c.id, false)}>
                Remove
              </Button>
            )
          }
        />
      ))}
    </>
  );
}
