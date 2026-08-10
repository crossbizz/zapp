import type { ReactElement } from "react";

import type {
  CloudProject,
  CloudProjectOpenIntent,
  LocalProjectSummary,
} from "../dashboard/model";

export function UnifiedProjectList(props: {
  readonly cloudProjects: readonly CloudProject[];
  readonly localProjects: readonly LocalProjectSummary[];
  readonly onOpenCloud: (intent: CloudProjectOpenIntent) => void;
  readonly onOpenLocal: (id: number) => void;
}): ReactElement {
  return (
    <div className="grid w-full gap-8 lg:grid-cols-2">
      <section aria-label="Local projects">
        <h2 className="mb-3 text-lg font-semibold">Local projects</h2>
        {props.localProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No local projects yet.
          </p>
        ) : (
          <div className="grid gap-3">
            {props.localProjects.map((project) => (
              <article
                className="rounded-xl border bg-card p-4"
                key={project.id}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="rounded-full border px-2 py-0.5 text-xs">
                      Local
                    </span>
                    <h3 className="mt-2 truncate font-medium">
                      {project.name}
                    </h3>
                    <p className="truncate text-xs text-muted-foreground">
                      {project.path}
                    </p>
                  </div>
                  <button
                    aria-label={`Open ${project.name}`}
                    className="rounded-md border px-3 py-2 text-sm"
                    onClick={() => props.onOpenLocal(project.id)}
                    type="button"
                  >
                    Open
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Cloud projects">
        <h2 className="mb-3 text-lg font-semibold">Cloud projects</h2>
        {props.cloudProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No cloud projects yet.
          </p>
        ) : (
          <div className="grid gap-3">
            {props.cloudProjects.map((project) => (
              <article
                className="rounded-xl border bg-card p-4"
                key={project.id}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="rounded-full border px-2 py-0.5 text-xs">
                      Cloud
                    </span>
                    <h3 className="mt-2 truncate font-medium">
                      {project.name}
                    </h3>
                    <p className="text-xs capitalize text-muted-foreground">
                      {project.supportLevel}
                    </p>
                  </div>
                  <button
                    aria-label={`Open ${project.name}`}
                    className="rounded-md border px-3 py-2 text-sm"
                    onClick={() =>
                      props.onOpenCloud({
                        mode: "cloud",
                        projectId: project.id,
                      })
                    }
                    type="button"
                  >
                    Open
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
