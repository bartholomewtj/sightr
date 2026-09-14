import { useCallback } from "react";
import { useNavigate } from "react-router";

import { useDashPrefs } from "./use-dash-prefs";
import { homePath } from "@/lib/nav";

export function useOpenSpace() {
  const navigate = useNavigate();
  const { expandSpace } = useDashPrefs();

  return useCallback(
    (workspaceId: string, options?: { replace?: boolean }) => {
      expandSpace(workspaceId);
      navigate(homePath(), options);
    },
    [expandSpace, navigate],
  );
}
