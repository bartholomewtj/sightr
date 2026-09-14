import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createChallenges, parseAuthData, readCbor, verifyCreate, verifyGet } from "./webauthn.ts";

const cat = (...xs: Uint8Array[]) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of xs) { out.set(x, p); p += x.length; } return out; };
const head = (major: number, n: number) => n < 24 ? Uint8Array.of((major << 5) | n) : n < 256 ? Uint8Array.of((major << 5) | 24, n) : Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
const uint = (n: number) => head(0, n), nint = (n: number) => head(1, -1 - n), bytes = (b: Uint8Array) => cat(head(2, b.length), b), text = (s: string) => { const b = new TextEncoder().encode(s); return cat(head(3, b.length), b); };
const map = (pairs: [Uint8Array, Uint8Array][]) => cat(head(5, pairs.length), ...pairs.flat());
const RP = "sightr.example", ORIGIN = "https://sightr.example";
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = publicKey.export({ format: "der", type: "spki" });
const point = new Uint8Array(spki.subarray(spki.length - 65));
const { privateKey: otherPrivateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const cose = (x: Uint8Array, y: Uint8Array, alg = -7) => map([[uint(1),uint(2)],[uint(3),nint(alg)],[nint(-1),uint(1)],[nint(-2),bytes(x)],[nint(-3),bytes(y)]]);
const auth = (rp: string, flags: number, counter: number, cred?: { id: Uint8Array; key: Uint8Array }) => cat(new Uint8Array(createHash("sha256").update(rp).digest()), Uint8Array.of(flags), Uint8Array.of(counter >>> 24, counter >>> 16, counter >>> 8, counter), ...(cred ? [new Uint8Array(16), Uint8Array.of(cred.id.length >> 8, cred.id.length & 255), cred.id, cred.key] : []));
const client = (type: string, challenge: string, origin = ORIGIN) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin }));
const attestation = (data: Uint8Array) => map([[text("fmt"),text("none")],[text("attStmt"),map([])],[text("authData"),bytes(data)]]);
const assertion = (challenge: string, counter: number, flags = 0x05) => { const cd = client("webauthn.get", challenge); const ad = auth(RP, flags, counter); const signed = cat(ad, new Uint8Array(createHash("sha256").update(cd).digest())); return { clientDataJSON: cd, authenticatorData: ad, signature: new Uint8Array(cryptoSign("sha256", signed, privateKey)) }; };

describe("WebAuthn helpers", () => {
  test("challenges are one-use, purpose-bound, and expire", () => { let now = 0; const c = createChallenges(() => now); const wrong = c.issue("assert"); expect(c.consume(wrong, "register")).toBe(false); expect(c.consume(wrong, "assert")).toBe(false); const once = c.issue("assert"); expect(c.consume(once, "assert")).toBe(true); expect(c.consume(once, "assert")).toBe(false); const expired = c.issue("assert"); now = 60_001; expect(c.consume(expired, "assert")).toBe(false); });
  test("reads supported CBOR and rejects malformed input", () => { expect(readCbor(new Uint8Array([0x18,42])).value).toBe(42); expect(readCbor(new Uint8Array([0x20])).value).toBe(-1); expect(readCbor(new Uint8Array([0x63,97,98,99])).value).toBe("abc"); expect(() => readCbor(new Uint8Array([0x9f]))).toThrow(); expect(() => readCbor(new Uint8Array([0x18]))).toThrow(); });
  test("verifies create and extracts the P-256 point", () => { expect(point.length).toBe(65); expect(point[0]).toBe(4); const id = new Uint8Array([1,2,3,4]); const ch = "create-challenge"; const c = client("webauthn.create", ch); const r = verifyCreate({ clientDataJSON:c, attestationObject:attestation(auth(RP,0x45,0,{id,key:cose(point.slice(1,33),point.slice(33))})), origin:ORIGIN, rpId:RP, challenge:ch }); expect(r.ok).toBe(true); if(r.ok){expect([...r.credentialId]).toEqual([...id]);expect([...r.publicKey]).toEqual([...point]);} });
  test("rejects bad create origin, UV, challenge, and non-ES256 COSE", () => { const id = new Uint8Array([9,8,7]); const key = (alg=-7) => attestation(auth(RP,0x45,0,{id,key:cose(point.slice(1,33),point.slice(33),alg)})); const base={clientDataJSON:client("webauthn.create","c"),attestationObject:key(),origin:ORIGIN,rpId:RP,challenge:"c"}; expect(verifyCreate({...base,origin:"https://evil.example"}).ok).toBe(false); expect(verifyCreate({...base,attestationObject: key().slice(0)}).ok).toBe(true); expect(verifyCreate({...base,attestationObject:attestation(auth(RP,0x41,0,{id,key:cose(point.slice(1,33),point.slice(33))}))}).ok).toBe(false); expect(verifyCreate({...base,challenge:"other"}).ok).toBe(false); expect(verifyCreate({...base,attestationObject:key(-257)}).ok).toBe(false); });
  test("verifies signatures and enforces assertion counters", () => { const c = "assert"; const good = assertion(c,0); const args={...good,publicKey:point,storedCounter:0,origin:ORIGIN,rpId:RP,challenge:c}; expect(verifyGet(args)).toEqual({ok:true,counter:null}); expect(verifyGet(args)).toEqual({ok:true,counter:null}); const flipped={...good,signature:new Uint8Array(good.signature)}; flipped.signature[0]!^=1; expect(verifyGet({...args,...flipped}).ok).toBe(false); const five=assertion(c,5); const advanced=verifyGet({...five,publicKey:point,storedCounter:0,origin:ORIGIN,rpId:RP,challenge:c}); expect(advanced.ok&&advanced.counter).toBe(5); expect(verifyGet({...five,publicKey:point,storedCounter:5,origin:ORIGIN,rpId:RP,challenge:c}).ok).toBe(false); const six=assertion(c,6); expect(verifyGet({...six,publicKey:point,storedCounter:5,origin:ORIGIN,rpId:RP,challenge:c})).toEqual({ok:true,counter:6}); });
  test("rejects bad signature, wrong rpIdHash, clear UV, non-increasing counter, and malformed COSE", () => { const c = "failure-cases"; const good = assertion(c, 1); const args = { ...good, publicKey: point, storedCounter: 0, origin: ORIGIN, rpId: RP, challenge: c }; const badSignature = new Uint8Array(good.signature); badSignature[0]! ^= 1; expect(verifyGet({ ...args, signature: badSignature }).ok).toBe(false); expect(verifyGet({ ...args, authenticatorData: auth("wrong.example", 0x05, 1) }).ok).toBe(false); expect(verifyGet({ ...args, authenticatorData: auth(RP, 0x01, 1) }).ok).toBe(false); expect(verifyGet({ ...args, storedCounter: 1 }).ok).toBe(false); const id = new Uint8Array([1, 2, 3]); const malformed = attestation(auth(RP, 0x45, 0, { id, key: new Uint8Array([0xff]) })); expect(verifyCreate({ clientDataJSON: client("webauthn.create", c), attestationObject: malformed, origin: ORIGIN, rpId: RP, challenge: c }).ok).toBe(false); });
});

describe("WebAuthn failure cases", () => {
  const signed = (challenge: string, counter: number, flags = 0x05, signingKey = privateKey, rp = RP) => {
    const clientDataJSON = client("webauthn.get", challenge);
    const authenticatorData = auth(rp, flags, counter);
    const signedData = cat(authenticatorData, new Uint8Array(createHash("sha256").update(clientDataJSON).digest()));
    const signature = new Uint8Array(cryptoSign("sha256", signedData, signingKey));
    return { clientDataJSON, authenticatorData, signature };
  };
  const getArgs = (assertion: ReturnType<typeof signed>, storedCounter = 0, rpId = RP) => ({ ...assertion, publicKey: point, storedCounter, origin: ORIGIN, rpId, challenge: "failure" });
  const createArgs = (attestationObject: Uint8Array) => ({ clientDataJSON: client("webauthn.create", "create-failure"), attestationObject, origin: ORIGIN, rpId: RP, challenge: "create-failure" });
  const validCose = cose(point.slice(1, 33), point.slice(33));
  const validAttestation = (data = auth(RP, 0x45, 0, { id: new Uint8Array([1, 2, 3]), key: validCose })) => attestation(data);

  test("rejects signatures from another key, auth-data-only signatures, and truncated signatures", () => {
    const differentKey = signed("failure", 1, 0x05, otherPrivateKey);
    expect(verifyGet({ ...getArgs(differentKey), challenge: "failure" })).toEqual({ ok: false });
    const authDataOnly = signed("failure", 1);
    authDataOnly.signature = new Uint8Array(cryptoSign("sha256", authDataOnly.authenticatorData, privateKey));
    expect(verifyGet({ ...getArgs(authDataOnly), challenge: "failure" })).toEqual({ ok: false });
    const truncated = signed("failure", 1);
    truncated.signature = truncated.signature.slice(0, 8);
    expect(verifyGet({ ...getArgs(truncated), challenge: "failure" })).toEqual({ ok: false });
  });

  test("rejects a wrong rpIdHash while preserving the origin check", () => {
    const wrongRp = signed("failure", 1, 0x05, privateKey, "other.example");
    expect(verifyGet({ ...getArgs(wrongRp), challenge: "failure" })).toEqual({ ok: false });
    const createWrongRp = validAttestation(auth("other.example", 0x45, 0, { id: new Uint8Array([1]), key: validCose }));
    expect(verifyCreate(createArgs(createWrongRp))).toEqual({ ok: false });
    expect(verifyGet({ ...getArgs(wrongRp, 0, "other.example"), origin: "https://other.example", challenge: "failure" })).toEqual({ ok: false });
  });

  test("rejects clear UV and clear UP flags when each assertion is signed", () => {
    const clearUv = signed("failure", 1, 0x01);
    const clearUp = signed("failure", 1, 0x04);
    expect(verifyGet({ ...getArgs(clearUv), challenge: "failure" })).toEqual({ ok: false });
    expect(verifyGet({ ...getArgs(clearUp), challenge: "failure" })).toEqual({ ok: false });
  });

  test("enforces counter equality and advancement rules", () => {
    expect(verifyGet({ ...getArgs(signed("failure", 7), 7), challenge: "failure" })).toEqual({ ok: false });
    expect(verifyGet({ ...getArgs(signed("failure", 3), 7), challenge: "failure" })).toEqual({ ok: false });
    expect(verifyGet({ ...getArgs(signed("failure", 8), 7), challenge: "failure" })).toEqual({ ok: true, counter: 8 });
    expect(verifyGet({ ...getArgs(signed("failure", 0), 9), challenge: "failure" })).toEqual({ ok: true, counter: null });
  });

  test("rejects malformed public keys", () => {
    const assertion = signed("failure", 1);
    expect(verifyGet({ ...getArgs(assertion), publicKey: point.slice(1), challenge: "failure" })).toEqual({ ok: false });
    expect(verifyGet({ ...getArgs(assertion), publicKey: new Uint8Array([3, ...point.slice(1)]), challenge: "failure" })).toEqual({ ok: false });
  });

  test("rejects malformed attestation COSE and CBOR shapes", () => {
    const basePairs: [Uint8Array, Uint8Array][] = [[uint(1), uint(2)], [uint(3), nint(-7)], [nint(-1), uint(1)], [nint(-2), bytes(point.slice(1, 33))], [nint(-3), bytes(point.slice(33))]];
    const withoutX = map(basePairs.filter(([key]) => key[0] !== 0x21));
    const shortX = map([[...basePairs[0]!], [...basePairs[1]!], [...basePairs[2]!], [nint(-2), bytes(point.slice(1, 32))], [...basePairs[4]!]]);
    const badCrv = map([[...basePairs[0]!], [...basePairs[1]!], [nint(-1), uint(2)], [...basePairs[3]!], [...basePairs[4]!]]);
    const badKty = map([[uint(1), uint(3)], [...basePairs[1]!], [...basePairs[2]!], [...basePairs[3]!], [...basePairs[4]!]]);
    const notMap = validAttestation(auth(RP, 0x45, 0, { id: new Uint8Array([1]), key: uint(1) }));
    const missingX = validAttestation(auth(RP, 0x45, 0, { id: new Uint8Array([1]), key: withoutX }));
    const shortPoint = validAttestation(auth(RP, 0x45, 0, { id: new Uint8Array([1]), key: shortX }));
    const wrongCurve = validAttestation(auth(RP, 0x45, 0, { id: new Uint8Array([1]), key: badCrv }));
    const wrongType = validAttestation(auth(RP, 0x45, 0, { id: new Uint8Array([1]), key: badKty }));
    const truncated = validAttestation().slice(0, -1);
    const rootNotMap = Uint8Array.of(1);
    const authDataText = map([[text("fmt"), text("none")], [text("attStmt"), map([])], [text("authData"), text("not-bytes")]]);
    const missingAuthData = map([[text("fmt"), text("none")], [text("attStmt"), map([])]]);
    expect(verifyCreate(createArgs(notMap))).toEqual({ ok: false });
    expect(verifyCreate(createArgs(missingX))).toEqual({ ok: false });
    expect(verifyCreate(createArgs(shortPoint))).toEqual({ ok: false });
    expect(verifyCreate(createArgs(wrongCurve))).toEqual({ ok: false });
    expect(verifyCreate(createArgs(wrongType))).toEqual({ ok: false });
    expect(verifyCreate(createArgs(truncated))).toEqual({ ok: false });
    expect(verifyCreate(createArgs(rootNotMap))).toEqual({ ok: false });
    expect(verifyCreate(createArgs(authDataText))).toEqual({ ok: false });
    expect(verifyCreate(createArgs(missingAuthData))).toEqual({ ok: false });
  });

  test("parseAuthData enforces lengths and skips optional attestation data when unset", () => {
    expect(() => parseAuthData(new Uint8Array(36))).toThrow();
    expect(() => parseAuthData(new Uint8Array([...auth(RP, 0x40, 0), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow();
    const overrun = new Uint8Array(55);
    overrun.set(auth(RP, 0x40, 0));
    overrun[53] = 0;
    overrun[54] = 20;
    expect(() => parseAuthData(overrun)).toThrow("short credential");
    const noAt = parseAuthData(auth(RP, 0x05, 0x01020304));
    expect(noAt).toEqual({ rpIdHash: noAt.rpIdHash, flags: 5, up: true, uv: true, at: false, counter: 0x01020304 });
    expect(noAt.credentialId).toBeUndefined();
    expect(noAt.publicKey).toBeUndefined();
  });

  test("readCbor rejects unsupported and truncated values", () => {
    expect(() => readCbor(Uint8Array.of(0xbf))).toThrow();
    expect(() => readCbor(Uint8Array.of(0xf6))).toThrow();
    expect(() => readCbor(Uint8Array.of(0x79, 0, 2, 0x61))).toThrow();
    expect(() => readCbor(Uint8Array.of(0x5a, 0, 0, 0, 4, 1))).toThrow();
    expect(readCbor(Uint8Array.of(0x82, 1, 2))).toEqual({ value: [1, 2], next: 3 });
    expect(() => readCbor(map([[bytes(Uint8Array.of(1)), uint(2)]]))).toThrow();
  });
});
