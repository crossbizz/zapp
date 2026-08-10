import { useCallback, useEffect, useState, type ReactElement } from "react";

import { appClient, type ListedApp } from "@/ipc/types/app";
import { platformAuthClient, platformAuthEventClient } from "../auth/contracts";
import type { PlatformAuthState } from "../auth/session";
import { dashboardClient } from "./contracts";
import { publishCloudProjectOpenIntent } from "./handoff";
import type {
  CloudProjectOpenIntent,
  CloudProjectPage,
  CreateCloudProject,
  LocalProjectSummary,
} from "./model";
import { UnifiedProjectDashboard } from "./surface";

function localProject(app: ListedApp): LocalProjectSummary {
  return {
    id: app.id,
    name: app.name,
    path: app.resolvedPath ?? app.path,
  };
}

export function DesktopProjectsDashboard(props: {
  readonly onOpenCloud?: (intent: CloudProjectOpenIntent) => void;
  readonly onOpenLocal: (id: number) => void;
}): ReactElement {
  const [auth, setAuth] = useState<PlatformAuthState>({ status: "signed-out" });
  const [localProjects, setLocalProjects] = useState<
    readonly LocalProjectSummary[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const onOpenCloud = props.onOpenCloud ?? publishCloudProjectOpenIntent;

  useEffect(() => {
    let active = true;
    const unsubscribe = platformAuthEventClient.onStateChanged((state) => {
      if (active) setAuth(state);
    });
    void Promise.all([platformAuthClient.snapshot({}), appClient.listApps()])
      .then(([state, local]) => {
        if (!active) return;
        setAuth(state);
        setLocalProjects(local.apps.map(localProject));
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const listCloudProjects = useCallback(
    async (input: {
      readonly cursor?: string;
      readonly limit: number;
    }): Promise<CloudProjectPage> => await dashboardClient.listProjects(input),
    [],
  );
  const createCloudProject = useCallback(
    async (input: CreateCloudProject): Promise<CloudProjectOpenIntent> =>
      await dashboardClient.createProject(input),
    [],
  );
  const openCloud = useCallback(
    async (intent: CloudProjectOpenIntent): Promise<void> => {
      onOpenCloud(
        await dashboardClient.openProject({ projectId: intent.projectId }),
      );
    },
    [onOpenCloud],
  );

  if (loading) return <p role="status">Loading projects…</p>;
  if (loadFailed) {
    return (
      <p
        className="m-8 rounded-xl border border-destructive/30 p-4"
        role="alert"
      >
        Project dashboard unavailable.
      </p>
    );
  }
  return (
    <UnifiedProjectDashboard
      cloudEnabled={auth.status === "authenticated" && auth.cloudEnabled}
      createCloudProject={createCloudProject}
      listCloudProjects={listCloudProjects}
      localProjects={localProjects}
      organizationId={
        auth.status === "signed-out" ? undefined : auth.selectedOrganizationId
      }
      onOpenCloud={(intent) => void openCloud(intent)}
      onOpenLocal={props.onOpenLocal}
    />
  );
}
