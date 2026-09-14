import { describe, expect, test } from "bun:test";
import { parseEnv } from "./env.ts";

describe("safe .env parser", () => {
 test("parses grammar without executing values", () => {
  const r=parseEnv('# comment\n  # indented\nDOUBLE_QUOTES="hello world"\nSINGLE_QUOTES=\'single value\'\nWITH_EQUALS=foo=bar=baz\nWITH_HASH=https://example.com/#section\nexport EXPORTED_VAR=123\nexport   EXPORTED_SPACES="spaced out"\nPWNED=$(touch /tmp/sightr-never)\nALSO_PWNED=`touch /tmp/sightr-never2`\nbun() { :; }\nDUP=old\nDUP=new', 'test.env');
  expect(r.values.get('DOUBLE_QUOTES')).toBe('hello world'); expect(r.values.get('WITH_EQUALS')).toBe('foo=bar=baz'); expect(r.values.get('PWNED')).toBe('$(touch /tmp/sightr-never)'); expect(r.values.get('DUP')).toBe('new'); expect(r.warnings[0]).toContain('test.env:11');
 });
 test("does not leak malformed content and handles CRLF",()=>{const r=parseEnv('OK=yes\r\nSIGHTR_VAPID_PRIVATE s3cret-value\r\n1FOO=x\r\nLAST=done','x.env'); expect(r.values.get('LAST')).toBe('done'); expect(r.values.has('SIGHTR_VAPID_PRIVATE')).toBe(false); expect(r.warnings.join(' ')).not.toContain('s3cret-value'); expect(r.warnings.join(' ')).toContain('x.env:2'); expect(r.warnings.join(' ')).toContain('x.env:3');});
});
