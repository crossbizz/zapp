import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import { platformAuthClient, platformAuthEventClient } from "./contracts";
import type { PlatformAuthState } from "./session";

export function PlatformAuthControl() {
  const [state, setState] = useState<PlatformAuthState>({
    status: "signed-out",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    const unsubscribe = platformAuthEventClient.onStateChanged((next) => {
      if (active) setState(next);
    });
    void platformAuthClient
      .snapshot({})
      .then((snapshot) => {
        if (active) setState(snapshot);
      })
      .catch(() => {
        if (active) setError("Account state unavailable");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function run(action: () => Promise<PlatformAuthState>) {
    setLoading(true);
    setError(undefined);
    try {
      setState(await action());
    } catch {
      setError("Account action failed");
    } finally {
      setLoading(false);
    }
  }

  if (loading && state.status === "signed-out") {
    return (
      <span className="no-app-region-drag ml-2 text-xs text-muted-foreground">
        Loading account…
      </span>
    );
  }

  if (state.status === "signed-out") {
    return (
      <div className="no-app-region-drag ml-2 flex items-center gap-1">
        {error && <span className="text-xs text-destructive">{error}</span>}
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={loading}
          aria-label="Sign in to Zapp"
          onClick={() => void run(() => platformAuthClient.signIn({}))}
        >
          Sign in
        </Button>
      </div>
    );
  }

  const memberships = state.identity.memberships.filter(
    (membership) => membership.status === "active",
  );
  return (
    <div className="no-app-region-drag ml-2 flex items-center gap-1">
      <div className="flex flex-col leading-none">
        <span className="max-w-36 truncate text-xs">
          {state.identity.user.displayName}
        </span>
        {state.status === "offline" && (
          <span className="text-[10px] text-amber-600">
            Offline — cloud features disabled
          </span>
        )}
      </div>
      <label className="sr-only" htmlFor="platform-active-organization">
        Active organization
      </label>
      <select
        id="platform-active-organization"
        aria-label="Active organization"
        className="h-7 max-w-36 rounded border bg-background px-1 text-xs"
        value={state.selectedOrganizationId}
        disabled={loading}
        onChange={(event) =>
          void run(() =>
            platformAuthClient.selectOrganization({
              organizationId: event.currentTarget.value,
            }),
          )
        }
      >
        {memberships.map((membership) => (
          <option
            key={membership.organization.id}
            value={membership.organization.id}
          >
            {membership.organization.name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        disabled={loading}
        aria-label="Sign out of Zapp"
        onClick={() => void run(() => platformAuthClient.signOut({}))}
      >
        Sign out
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
