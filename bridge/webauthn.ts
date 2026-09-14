import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";

export const CHALLENGE_TTL_MS = 60_000;
export type Purpose = "register" | "assert";
export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
export const fromB64u = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64url"));

export interface Challenges {
  issue(purpose: Purpose): string;
  consume(challenge: string, purpose: Purpose): boolean;
  size(): number;
}

export function createChallenges(now = Date.now): Challenges {
  const map = new Map<string, { purpose: Purpose; expires: number }>();
  const prune = (): void => {
    const time = now();
    for (const [key, value] of map) {
      if (time > value.expires) {
        map.delete(key);
      }
    }
    while (map.size >= 64) {
      map.delete(map.keys().next().value!);
    }
  };
  const issue = (purpose: Purpose): string => {
    prune();
    const challenge = b64u(randomBytes(32));
    map.set(challenge, { purpose, expires: now() + CHALLENGE_TTL_MS });
    return challenge;
  };
  const consume = (challenge: string, purpose: Purpose): boolean => {
    const value = map.get(challenge);
    map.delete(challenge);
    return !!value && value.purpose === purpose && now() <= value.expires;
  };
  const size = (): number => map.size;
  return { issue, consume, size };
}

export type Cbor = number | Uint8Array | string | Cbor[] | Map<number | string, Cbor>;

export function readCbor(buf: Uint8Array, offset = 0): { value: Cbor; next: number } {
  const first = buf[offset++];
  if (first === undefined) {
    throw new Error("truncated");
  }
  const major = first >> 5;
  const additionalInfo = first & 31;
  if (additionalInfo === 31 || major > 5) {
    throw new Error("unsupported cbor");
  }
  let number: number;
  if (additionalInfo < 24) {
    number = additionalInfo;
  } else if (additionalInfo === 24) {
    if (offset >= buf.length) {
      throw new Error("truncated");
    }
    number = buf[offset++]!;
  } else if (additionalInfo === 25) {
    if (offset + 2 > buf.length) {
      throw new Error("truncated");
    }
    number = (buf[offset++]! << 8) | buf[offset++]!;
  } else if (additionalInfo === 26) {
    if (offset + 4 > buf.length) {
      throw new Error("truncated");
    }
    number = (buf[offset++]! * 0x1000000) + (buf[offset++]! << 16) + (buf[offset++]! << 8) + buf[offset++]!;
  } else {
    throw new Error("unsupported integer");
  }
  if (major === 0) {
    return { value: number, next: offset };
  }
  if (major === 1) {
    return { value: -1 - number, next: offset };
  }
  if (major === 2 || major === 3) {
    const end = offset + number;
    if (end > buf.length) {
      throw new Error("truncated");
    }
    const value = major === 2 ? buf.slice(offset, end) : new TextDecoder().decode(buf.slice(offset, end));
    return { value, next: end };
  }
  if (major === 4) {
    const values: Cbor[] = [];
    for (let index = 0; index < number; index++) {
      const result = readCbor(buf, offset);
      values.push(result.value);
      offset = result.next;
    }
    return { value: values, next: offset };
  }
  const map = new Map<number | string, Cbor>();
  for (let index = 0; index < number; index++) {
    const key = readCbor(buf, offset);
    offset = key.next;
    const value = readCbor(buf, offset);
    offset = value.next;
    if (typeof key.value !== "number" && typeof key.value !== "string") {
      throw new Error("bad key");
    }
    map.set(key.value, value.value);
  }
  return { value: map, next: offset };
}

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  up: boolean;
  uv: boolean;
  at: boolean;
  counter: number;
  credentialId?: Uint8Array;
  publicKey?: Uint8Array;
}

export type AuthData = AuthenticatorData;

// WebAuthn §6.1.1: parse the authenticator data structure.
export function parseAuthData(data: Uint8Array): AuthenticatorData {
  if (data.length < 37) {
    throw new Error("short auth data");
  }
  const flags = data[32]!;
  const counter = data[33]! * 0x1000000 + (data[34]! << 16) + (data[35]! << 8) + data[36]!;
  const result: AuthenticatorData = {
    rpIdHash: data.slice(0, 32),
    flags,
    up: !!(flags & 1),
    uv: !!(flags & 4),
    at: !!(flags & 64),
    counter,
  };
  if (!result.at) {
    return result;
  }
  if (data.length < 55) {
    throw new Error("short attested data");
  }
  let offset = 53;
  const credentialIdLength = (data[offset++]! << 8) | data[offset++]!;
  if (offset + credentialIdLength > data.length) {
    throw new Error("short credential");
  }
  result.credentialId = data.slice(offset, offset + credentialIdLength);
  offset += credentialIdLength;
  result.publicKey = coseToPoint(data, offset);
  return result;
}

const reject = (): { ok: false } => {
  console.warn("[bridge] webauthn: rejected");
  return { ok: false };
};

interface ClientDataInput {
  clientDataJSON: Uint8Array;
  challenge: string;
  origin: string;
}

// WebAuthn §5.8.1: parse and validate the client data JSON.
function checkClientData(input: ClientDataInput, type: string): boolean {
  try {
    const value = JSON.parse(new TextDecoder().decode(input.clientDataJSON)) as unknown;
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const clientData = value as {
      type?: unknown;
      challenge?: unknown;
      origin?: unknown;
    };
    if (clientData.type !== type || clientData.challenge !== input.challenge || clientData.origin !== input.origin) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// WebAuthn §6.5.6: parse and validate the supported ES256 COSE key.
function coseToPoint(data: Uint8Array, offset: number): Uint8Array {
  const cose = readCbor(data, offset).value;
  if (!(cose instanceof Map)) {
    throw new Error("bad cose");
  }
  if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) {
    throw new Error("unsupported cose");
  }
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
    throw new Error("bad point");
  }
  return new Uint8Array([4, ...x, ...y]);
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

// WebAuthn §6.5.6: convert the P-256 point to a crypto public key.
function publicKeyFromPoint(publicKey: Uint8Array) {
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64u(publicKey.slice(1, 33)),
      y: b64u(publicKey.slice(33, 65)),
    },
    format: "jwk",
  });
}

// WebAuthn §6.3.4: verify the assertion signature over authenticator and client data.
function verifySignature(
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array,
  publicKey: Uint8Array,
  signature: Uint8Array,
): boolean {
  const key = publicKeyFromPoint(publicKey);
  const clientDataHash = new Uint8Array(createHash("sha256").update(clientDataJSON).digest());
  const signedData = new Uint8Array([...authenticatorData, ...clientDataHash]);
  return cryptoVerify("sha256", signedData, key, signature);
}

// WebAuthn §7.1: verify a registration attestation and extract its credential.
export function verifyCreate(
  input: {
    clientDataJSON: Uint8Array;
    attestationObject: Uint8Array;
    origin: string;
    rpId: string;
    challenge: string;
  },
): { ok: true; credentialId: Uint8Array; publicKey: Uint8Array; counter: number } | { ok: false } {
  try {
    if (!checkClientData(input, "webauthn.create")) {
      return reject();
    }
    const root = readCbor(input.attestationObject).value;
    if (!(root instanceof Map)) {
      return reject();
    }
    const authData = root.get("authData");
    if (!(authData instanceof Uint8Array)) {
      return reject();
    }
    const parsed = parseAuthData(authData);
    const rpIdHash = new Uint8Array(createHash("sha256").update(input.rpId).digest());
    if (!parsed.up || !parsed.uv || !parsed.at || !sameBytes(parsed.rpIdHash, rpIdHash) || !parsed.credentialId || !parsed.publicKey) {
      return reject();
    }
    return { ok: true, credentialId: parsed.credentialId, publicKey: parsed.publicKey, counter: parsed.counter };
  } catch {
    return reject();
  }
}

// WebAuthn §7.2: verify an assertion and enforce its signature and counter.
export function verifyGet(
  input: {
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
    signature: Uint8Array;
    publicKey: Uint8Array;
    storedCounter: number;
    origin: string;
    rpId: string;
    challenge: string;
  },
): { ok: true; counter: number | null } | { ok: false } {
  try {
    if (!checkClientData(input, "webauthn.get")) {
      return reject();
    }
    const parsed = parseAuthData(input.authenticatorData);
    const rpIdHash = new Uint8Array(createHash("sha256").update(input.rpId).digest());
    if (!parsed.up || !parsed.uv || !sameBytes(parsed.rpIdHash, rpIdHash) || input.publicKey.length !== 65 || input.publicKey[0] !== 4) {
      return reject();
    }
    if (!verifySignature(input.authenticatorData, input.clientDataJSON, input.publicKey, input.signature)) {
      return reject();
    }
    if (parsed.counter === 0) {
      return { ok: true, counter: null };
    }
    if (parsed.counter <= input.storedCounter) {
      return reject();
    }
    return { ok: true, counter: parsed.counter };
  } catch {
    return reject();
  }
}
