import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pushForget, pushList } from "./push-ops.ts";
import { CtlError } from "./types.ts";

const FIXTURE_P256DH = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const FIXTURE_AUTH = "AgICAgICAgICAgICAgICAg";
const noopRun = async () => ({ code: 0, stdout: "", stderr: "" });

async function seededDir(rows: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "sightr-push-ops-"));
  await writeFile(join(dir, "push-subscriptions.json"), JSON.stringify(rows));
  return dir;
}

function row(endpoint: string, extra: Record<string, string> = {}) {
  return { endpoint, keys: { p256dh: FIXTURE_P256DH, auth: FIXTURE_AUTH }, ...extra };
}

test("push-list prints metadata and never keys", async () => {
  const dir = await seededDir([
    row("https://fcm.googleapis.com/phone", { createdAt: "2026-09-01T00:00:00.000Z", userAgent: "iPhone" }),
  ]);
  const lines: string[] = [];
  await pushList({ HERDR_PLUGIN_STATE_DIR: dir, HERDR_PLUGIN_CONFIG_DIR: dir }, noopRun, (line) => lines.push(line));
  const out = lines.join("\n");
  expect(out).toContain("https://fcm.googleapis.com/phone");
  expect(out).toContain("iPhone");
  expect(out).not.toContain("p256dh");
  expect(out).not.toContain("auth");
  expect(out).not.toContain(FIXTURE_P256DH);
  expect(out).not.toContain(FIXTURE_AUTH);
});

test("push-list on an empty store prints a one-line notice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sightr-push-ops-empty-"));
  const lines: string[] = [];
  await pushList({ HERDR_PLUGIN_STATE_DIR: dir, HERDR_PLUGIN_CONFIG_DIR: dir }, noopRun, (line) => lines.push(line));
  expect(lines).toEqual(["no push subscriptions"]);
});

test("push-forget requires an explicit match", async () => {
  await expect(pushForget([])).rejects.toBeInstanceOf(CtlError);
});

test("push-forget <substr> drops matching rows and persists", async () => {
  const dir = await seededDir([
    row("https://web.push.apple.com/one"),
    row("https://fcm.googleapis.com/keep"),
  ]);
  const lines: string[] = [];
  await pushForget(
    ["apple.com"],
    { HERDR_PLUGIN_STATE_DIR: dir, HERDR_PLUGIN_CONFIG_DIR: dir },
    noopRun,
    (line) => lines.push(line),
  );
  expect(lines).toEqual(["forgot 1 subscription(s)"]);
  const saved = JSON.parse(await readFile(join(dir, "push-subscriptions.json"), "utf8")) as { endpoint: string }[];
  expect(saved.map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/keep"]);
});

test("push-forget * drops every row", async () => {
  const dir = await seededDir([row("https://fcm.googleapis.com/a"), row("https://fcm.googleapis.com/b")]);
  const lines: string[] = [];
  await pushForget(
    ["*"],
    { HERDR_PLUGIN_STATE_DIR: dir, HERDR_PLUGIN_CONFIG_DIR: dir },
    noopRun,
    (line) => lines.push(line),
  );
  expect(lines).toEqual(["forgot 2 subscription(s)"]);
  const saved = JSON.parse(await readFile(join(dir, "push-subscriptions.json"), "utf8")) as unknown[];
  expect(saved).toEqual([]);
});
