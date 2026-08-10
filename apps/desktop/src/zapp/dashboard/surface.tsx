import { useEffect, useRef, useState, type ReactElement } from "react";

import { UnifiedProjectList } from "../project-list/list";
import type {
  CloudProject,
  CloudProjectOpenIntent,
  CloudProjectPage,
  CreateCloudProject,
  LocalProjectSummary,
} from "./model";

const EXPLORATORY_PATTERN =
  /\b(?:idea|explore|experiment|prototype|try)\b|\bwhat\s+if\b|\bnot\s+sure\b/u;

function recommendedMode(prompt: string): CreateCloudProject["mode"] {
  return EXPLORATORY_PATTERN.test(prompt.toLocaleLowerCase("en-US"))
    ? "prototype"
    : "build";
}

export function UnifiedProjectDashboard(props: {
  readonly cloudEnabled: boolean;
  readonly organizationId?: string;
  readonly createCloudProject: (
    input: CreateCloudProject,
  ) => Promise<CloudProjectOpenIntent>;
  readonly listCloudProjects: (input: {
    readonly cursor?: string;
    readonly limit: number;
  }) => Promise<CloudProjectPage>;
  readonly localProjects: readonly LocalProjectSummary[];
  readonly onOpenCloud: (intent: CloudProjectOpenIntent) => void;
  readonly onOpenLocal: (id: number) => void;
}): ReactElement {
  const [cloudProjects, setCloudProjects] = useState<readonly CloudProject[]>(
    [],
  );
  const [nextCursor, setNextCursor] = useState<string | null>();
  const [loadedOrganizationId, setLoadedOrganizationId] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const [creationFailed, setCreationFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const pendingCreation = useRef<CreateCloudProject | undefined>(undefined);
  const creationOrganizationId = useRef(props.organizationId);
  const visibleCloudProjects =
    loadedOrganizationId === props.organizationId ? cloudProjects : [];
  const visibleNextCursor =
    loadedOrganizationId === props.organizationId ? nextCursor : undefined;

  useEffect(() => {
    if (creationOrganizationId.current === props.organizationId) return;
    creationOrganizationId.current = props.organizationId;
    pendingCreation.current = undefined;
    setCreationFailed(false);
  }, [props.organizationId]);

  useEffect(() => {
    const organizationId = props.organizationId;
    if (!props.cloudEnabled || organizationId === undefined) {
      generation.current += 1;
      setCloudProjects([]);
      setNextCursor(undefined);
      setLoadedOrganizationId(undefined);
      setLoading(false);
      setListFailed(false);
      return;
    }
    const current = generation.current + 1;
    generation.current = current;
    setCloudProjects([]);
    setNextCursor(undefined);
    setLoadedOrganizationId(undefined);
    setLoading(true);
    setListFailed(false);
    void props
      .listCloudProjects({ limit: 24 })
      .then((page) => {
        if (generation.current !== current) return;
        if (
          page.items.some(
            (project) => project.organizationId !== organizationId,
          )
        ) {
          throw new Error("Project page tenant mismatch.");
        }
        setCloudProjects(page.items);
        setNextCursor(page.nextCursor);
        setLoadedOrganizationId(organizationId);
      })
      .catch(() => {
        if (generation.current === current) setListFailed(true);
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
  }, [
    attempt,
    props.cloudEnabled,
    props.listCloudProjects,
    props.organizationId,
  ]);

  async function loadMore(): Promise<void> {
    const organizationId = props.organizationId;
    if (
      organizationId === undefined ||
      visibleNextCursor === undefined ||
      visibleNextCursor === null ||
      loading
    ) {
      return;
    }
    const current = generation.current;
    setLoading(true);
    setListFailed(false);
    try {
      const page = await props.listCloudProjects({
        cursor: visibleNextCursor,
        limit: 24,
      });
      if (generation.current !== current) return;
      if (
        page.items.some((project) => project.organizationId !== organizationId)
      ) {
        throw new Error("Project page tenant mismatch.");
      }
      setCloudProjects((projects) => {
        const ids = new Set(projects.map((project) => project.id));
        return [
          ...projects,
          ...page.items.filter((project) => !ids.has(project.id)),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch {
      if (generation.current === current) setListFailed(true);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }

  async function submit(): Promise<void> {
    const trimmed = prompt.trim();
    if (trimmed.length < 10 || submitting) return;
    setSubmitting(true);
    setCreationFailed(false);
    try {
      const pending =
        pendingCreation.current ??
        ({
          operationId: crypto.randomUUID(),
          prompt: trimmed,
          mode: recommendedMode(trimmed),
        } satisfies CreateCloudProject);
      pendingCreation.current = pending;
      const intent = await props.createCloudProject(pending);
      pendingCreation.current = undefined;
      props.onOpenCloud(intent);
    } catch {
      setCreationFailed(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-8 py-10">
      <header>
        <p className="text-sm font-medium text-primary">Projects</p>
        <h1 className="mt-1 text-3xl font-semibold">
          Local and cloud, side by side
        </h1>
      </header>

      {props.cloudEnabled ? (
        <form
          className="rounded-2xl border bg-card p-4 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label
            className="block text-sm font-medium"
            htmlFor="zapp-cloud-prompt"
          >
            Describe your project
          </label>
          <textarea
            className="mt-2 min-h-24 w-full resize-y rounded-xl border bg-background p-3"
            id="zapp-cloud-prompt"
            onChange={(event) => {
              pendingCreation.current = undefined;
              setCreationFailed(false);
              setPrompt(event.target.value);
            }}
            placeholder="Describe your idea. zapp will build, test, and ship it."
            rows={3}
            value={prompt}
          />
          <div className="mt-3 flex justify-end">
            <button
              className="rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
              disabled={prompt.trim().length < 10 || submitting}
              type="submit"
            >
              Create cloud project
            </button>
          </div>
        </form>
      ) : (
        <p className="rounded-xl border p-4 text-sm" role="status">
          Offline — cloud projects unavailable
        </p>
      )}

      {creationFailed ? (
        <div
          className="rounded-xl border border-destructive/30 p-4"
          role="alert"
        >
          <p>Cloud project creation did not finish.</p>
          <button
            className="mt-2 rounded-md border px-3 py-2"
            onClick={() => void submit()}
            type="button"
          >
            Retry project creation
          </button>
        </div>
      ) : null}
      {listFailed ? (
        <div
          className="rounded-xl border border-destructive/30 p-4"
          role="alert"
        >
          <p>Cloud projects could not be loaded.</p>
          <button
            className="mt-2 rounded-md border px-3 py-2"
            onClick={() => setAttempt((n) => n + 1)}
            type="button"
          >
            Retry cloud project list
          </button>
        </div>
      ) : null}
      {loading && visibleCloudProjects.length === 0 ? (
        <p role="status">Loading cloud projects…</p>
      ) : null}

      <UnifiedProjectList
        cloudProjects={visibleCloudProjects}
        localProjects={props.localProjects}
        onOpenCloud={props.onOpenCloud}
        onOpenLocal={props.onOpenLocal}
      />

      {visibleNextCursor === undefined || visibleNextCursor === null ? null : (
        <button
          className="self-center rounded-md border px-4 py-2"
          disabled={loading}
          onClick={() => void loadMore()}
          type="button"
        >
          Load more cloud projects
        </button>
      )}
    </section>
  );
}
