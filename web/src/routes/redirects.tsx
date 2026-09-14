import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";

import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { homePath } from "@/lib/nav";

// Redirect /spaces → /
export function SpacesRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(homePath(), { replace: true });
  }, [navigate]);

  return null;
}

// Redirect /space/:spaceId → / with that space expanded first
export function SpaceRedirect() {
  const { spaceId = "" } = useParams();
  const navigate = useNavigate();
  const { expandSpace } = useDashPrefs();

  useEffect(() => {
    if (spaceId) {
      expandSpace(spaceId);
    }
    navigate(homePath(), { replace: true });
  }, [spaceId, expandSpace, navigate]);

  return null;
}
