import { createTypedHandler } from "@/ipc/handlers/base";

import type { CloudDashboardApi } from "./api";
import { dashboardContracts } from "./contracts";

export function registerCloudDashboardHandlers(api: CloudDashboardApi): void {
  createTypedHandler(dashboardContracts.getFeatureFlags, async () =>
    api.getFeatureFlags(),
  );
  createTypedHandler(dashboardContracts.listProjects, async (_event, input) =>
    api.listProjects(input),
  );
  createTypedHandler(dashboardContracts.createProject, async (_event, input) =>
    api.createProject(input),
  );
  createTypedHandler(dashboardContracts.openProject, async (_event, input) =>
    api.openProject(input.projectId),
  );
}
