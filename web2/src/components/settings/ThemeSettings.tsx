// Same job and name as T3 Code apps/web/src/components/settings/ThemeSettings.tsx @ e3b35d1b (pattern;
// MIT, see THIRD_PARTY.md). T3's is a theme editor; Sightr's is v1's three-way Appearance control
// (web/src/components/theme-control.tsx) as a settings row: Dark (web2's default), Light, or System.
import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme, type Theme } from "@/hooks/use-theme";
import { SettingsChoice, SettingsRow } from "./settingsLayout";

const OPTIONS: ReadonlyArray<{ value: Theme; label: string; icon: React.ReactNode }> = [
  { value: "dark", label: "Dark", icon: <Moon className="size-4" aria-hidden /> },
  { value: "light", label: "Light", icon: <Sun className="size-4" aria-hidden /> },
  { value: "system", label: "System", icon: <Monitor className="size-4" aria-hidden /> },
];

export function ThemeSettings() {
  const { theme, setTheme } = useTheme();
  return (
    <SettingsRow
      title="Appearance"
      description="Dark, light, or follow the system. This device only."
      control={<SettingsChoice label="Appearance" value={theme} options={OPTIONS} onChange={setTheme} />}
    />
  );
}
