// Adapted from T3 Code apps/web/src/components/Sidebar.snooze.ts and
// packages/client-runtime/src/state/threadSettled.ts @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: epoch milliseconds instead of ISO strings, no Effect DateTime, Sightr's morning is 08:00,
// and `resolveCustomSnooze` reads a native `datetime-local` value.

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const EVENING_HOUR = 18;
const MORNING_HOUR = 8;

export type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  readonly whenLabel: string;
  /** Epoch ms. */
  readonly snoozedUntil: number;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function snoozeAtHour(base: Date, hour: number): Date {
  const next = new Date(base.getTime());
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = new Date(base.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
  const presets: SnoozePreset[] = [
    { id: "hour", label: "In 1 hour", whenLabel: snoozeTimeOfDayLabel(inAnHour), snoozedUntil: inAnHour.getTime() },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: snoozeTimeOfDayLabel(inThreeHours),
      snoozedUntil: inThreeHours.getTime(),
    },
  ];

  const evening = snoozeAtHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({ id: "evening", label: "This evening", whenLabel: snoozeTimeOfDayLabel(evening), snoozedUntil: evening.getTime() });
  }

  const tomorrow = snoozeAtHour(addSnoozeDays(now, 1), MORNING_HOUR);
  presets.push({ id: "tomorrow", label: "Tomorrow", whenLabel: snoozeTimeOfDayLabel(tomorrow), snoozedUntil: tomorrow.getTime() });

  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = snoozeAtHour(addSnoozeDays(now, daysUntilMonday), MORNING_HOUR);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${snoozeTimeOfDayLabel(nextWeek)}`,
      snoozedUntil: nextWeek.getTime(),
    });
  }

  return presets;
}

/** Time left until the wake: "now", "12m", "3h", "2d". */
export function snoozeWakeLabel(snoozedUntil: number, now: number): string {
  if (!Number.isFinite(snoozedUntil) || !Number.isFinite(now)) return "now";
  const remainingMs = snoozedUntil - now;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

/** When it wakes, in words: "4:30 PM", "tomorrow 8:00 AM", "Mon 8:00 AM", "Oct 30, 8:00 AM". */
export function snoozeWakeDescription(snoozedUntil: number, now: Date): string {
  const wake = new Date(snoozedUntil);
  if (!Number.isFinite(wake.getTime())) return "";
  const time = snoozeTimeOfDayLabel(wake);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  const weekday = wake.toLocaleDateString(undefined, { weekday: "short" });
  if (dayDelta < 7) return `${weekday} ${time}`;
  const date = wake.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date}, ${time}`;
}

/**
 * A `datetime-local` value ("2026-10-17T08:00") as epoch ms, or null when it is malformed, does not
 * exist locally (a DST gap) or is not in the future.
 */
export function resolveCustomSnooze(value: string, now: Date): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value);
  if (!match) return null;
  const [, date, time] = match as unknown as [string, string, string];
  const wake = new Date(`${date}T${time}:00`);
  // Reject rolled-over dates and nonexistent local times during DST changes.
  if (localSnoozeDate(wake) !== date || localSnoozeTime(wake) !== time) return null;
  return Number.isFinite(wake.getTime()) && wake.getTime() > now.getTime() ? wake.getTime() : null;
}

export function localSnoozeDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localSnoozeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The `datetime-local` value for a time (the picker's default and `min`). */
export function toDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  return `${localSnoozeDate(d)}T${localSnoozeTime(d)}`;
}
