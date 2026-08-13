'use client';

import { useCallback, useEffect, useState } from 'react';

import { createControlPlaneClient } from '../../lib/api';
import { decodeThumbnail, revokeThumbnail } from './project-thumbnail';

type Client = ReturnType<typeof createControlPlaneClient>;
type Project = Awaited<ReturnType<Client['listProjects']>>['items'][number];
type Summary = Awaited<ReturnType<Client['getProjectSummaries']>>['summaries'][number];

const MAX_THUMBNAIL_CONCURRENCY = 6;

export interface ProjectDashboardState {
  readonly loading: boolean;
  readonly projects: readonly Project[];
  readonly projectsFailed: boolean;
  readonly retry: () => void;
  readonly summaries: ReadonlyMap<string, Summary>;
  readonly summaryFailed: boolean;
  readonly thumbnailUrls: ReadonlyMap<string, string>;
}

export interface UseProjectDashboardOptions {
  readonly limit: number;
  readonly organizationId: string | undefined;
}

export function useProjectDashboard({
  limit,
  organizationId,
}: UseProjectDashboardOptions): ProjectDashboardState {
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [summaries, setSummaries] = useState<ReadonlyMap<string, Summary>>(new Map());
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [thumbnailUrls, setThumbnailUrls] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    const abortController = new AbortController();
    const generationUrls = new Set<string>();
    const isCurrent = (): boolean => !abortController.signal.aborted;

    setProjects([]);
    setSummaries(new Map());
    setThumbnailUrls(new Map());
    setProjectsFailed(false);
    setSummaryFailed(false);

    if (organizationId === undefined) {
      setLoading(false);
      return () => {
        abortController.abort();
      };
    }

    const client = createControlPlaneClient(organizationId);
    setLoading(true);

    const loadThumbnails = async (values: readonly Summary[]): Promise<void> => {
      const pending = values.filter((summary) => summary.previewThumbnail !== null);
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        while (isCurrent()) {
          const index = nextIndex;
          nextIndex += 1;
          const summary = pending[index];
          if (summary === undefined || summary.previewThumbnail === null) return;
          try {
            const response = await client.getProjectPreviewThumbnail(
              summary.projectId,
              summary.previewThumbnail.artifactId,
              abortController.signal,
            );
            const url = URL.createObjectURL(decodeThumbnail(response));
            if (!isCurrent()) {
              revokeThumbnail(url);
              return;
            }
            generationUrls.add(url);
            setThumbnailUrls((existing) => new Map(existing).set(summary.projectId, url));
          } catch {
            if (!isCurrent()) return;
          }
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(MAX_THUMBNAIL_CONCURRENCY, pending.length) },
          () => worker(),
        ),
      );
    };

    const load = async (): Promise<void> => {
      try {
        const page = await client.listProjects({ limit }, abortController.signal);
        if (!isCurrent()) return;
        setProjects(page.items);
        if (page.items.length === 0) return;

        try {
          const response = await client.getProjectSummaries(
            { projectId: page.items.map((project) => project.id) },
            abortController.signal,
          );
          if (!isCurrent()) return;
          setSummaries(new Map(response.summaries.map((summary) => [summary.projectId, summary])));
          await loadThumbnails(response.summaries);
        } catch {
          if (isCurrent()) setSummaryFailed(true);
        }
      } catch {
        if (isCurrent()) setProjectsFailed(true);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    };

    void load();
    return () => {
      abortController.abort();
      for (const url of generationUrls) revokeThumbnail(url);
    };
  }, [attempt, limit, organizationId]);

  const retry = useCallback((): void => {
    setAttempt((value) => value + 1);
  }, []);

  return {
    loading,
    projects,
    projectsFailed,
    retry,
    summaries,
    summaryFailed,
    thumbnailUrls,
  };
}
