'use client';

import { ZappApiError } from '@zapp/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createControlPlaneClient,
  type BuilderRun,
  type CreatedConversation,
  type ProjectConversation,
} from '../lib/api';

const pageSize = 100;

interface ConversationLoadState {
  readonly conversations: readonly ProjectConversation[];
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly scopeKey: string;
}

function emptyState(scopeKey: string): ConversationLoadState {
  return { conversations: [], error: undefined, loading: true, scopeKey };
}

function legacyConversationSummaries(
  runs: readonly BuilderRun[],
  projectId: string,
): readonly ProjectConversation[] {
  const grouped = new Map<string, BuilderRun[]>();
  for (const run of runs) {
    const group = grouped.get(run.conversationId) ?? [];
    group.push(run);
    grouped.set(run.conversationId, group);
  }
  return [...grouped.entries()]
    .flatMap(([conversationId, conversationRuns]) => {
      const ordered = [...conversationRuns].sort(
        (left, right) => left.conversationRunNumber - right.conversationRunNumber,
      );
      const first = ordered[0];
      const latest = ordered.at(-1);
      if (first === undefined || latest === undefined) return [];
      return [
        {
          createdAt: first.startedAt,
          id: conversationId,
          latestRun: { id: latest.id, status: latest.status },
          projectId,
          runCount: latest.conversationRunNumber,
          title: 'Project conversation',
          updatedAt: latest.completedAt ?? latest.startedAt,
        },
      ];
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export interface ProjectConversationsState {
  readonly conversations: readonly ProjectConversation[];
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly recordConversation: (conversation: CreatedConversation, run: BuilderRun) => void;
  readonly recordRun: (run: BuilderRun) => void;
  readonly refresh: () => void;
}

export function useProjectConversations(
  projectId: string,
  organizationId: string | undefined,
): ProjectConversationsState {
  const scopeKey = `${organizationId ?? 'pending'}:${projectId}`;
  const [state, setState] = useState<ConversationLoadState>(() => emptyState(scopeKey));
  const [refreshToken, setRefreshToken] = useState(0);
  const generationRef = useRef(0);
  const currentState = state.scopeKey === scopeKey ? state : emptyState(scopeKey);

  useEffect(() => {
    if (organizationId === undefined) {
      generationRef.current += 1;
      setState(emptyState(scopeKey));
      return;
    }
    const controller = new AbortController();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setState(emptyState(scopeKey));
    const isStale = (): boolean =>
      controller.signal.aborted || generationRef.current !== generation;

    const load = async (): Promise<void> => {
      try {
        const client = createControlPlaneClient(organizationId);
        const items: ProjectConversation[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listProjectConversations(
            projectId,
            { ...(cursor === undefined ? {} : { cursor }), limit: pageSize },
            controller.signal,
          );
          items.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        if (isStale()) return;
        setState({ conversations: items, error: undefined, loading: false, scopeKey });
      } catch (error) {
        if (isStale()) return;
        if (error instanceof ZappApiError && error.status === 404) {
          try {
            const runs = await createControlPlaneClient(organizationId).listRuns(
              projectId,
              controller.signal,
            );
            if (isStale()) return;
            const conversations = legacyConversationSummaries(runs.items, projectId);
            if (conversations.length > 0) {
              setState({ conversations, error: undefined, loading: false, scopeKey });
              return;
            }
          } catch {
            if (isStale()) return;
          }
        }
        setState({
          conversations: [],
          error: 'Conversation history could not be loaded.',
          loading: false,
          scopeKey,
        });
      }
    };

    void load();
    return () => {
      controller.abort();
    };
  }, [organizationId, projectId, refreshToken, scopeKey]);

  const refresh = useCallback((): void => {
    setRefreshToken((current) => current + 1);
  }, []);

  const recordConversation = useCallback(
    (conversation: CreatedConversation, run: BuilderRun): void => {
      if (
        organizationId === undefined ||
        conversation.organizationId !== organizationId ||
        conversation.projectId !== projectId
      ) {
        return;
      }
      setState((currentStateValue) => {
        const current =
          currentStateValue.scopeKey === scopeKey
            ? currentStateValue.conversations
            : emptyState(scopeKey).conversations;
        const existing = current.find((candidate) => candidate.id === conversation.id);
        const summary: ProjectConversation = {
          createdAt: conversation.createdAt,
          id: conversation.id,
          latestRun: { id: run.id, status: run.status },
          projectId: conversation.projectId,
          runCount: run.conversationRunNumber,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
        };
        return {
          conversations: [
            summary,
            ...current.filter((candidate) => candidate.id !== existing?.id),
          ].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
          error: undefined,
          loading: false,
          scopeKey,
        };
      });
    },
    [organizationId, projectId, scopeKey],
  );

  const recordRun = useCallback(
    (run: BuilderRun): void => {
      if (organizationId === undefined || run.organizationId !== organizationId) return;
      setState((currentStateValue) => {
        if (currentStateValue.scopeKey !== scopeKey) return currentStateValue;
        const existing = currentStateValue.conversations.find(
          (conversation) => conversation.id === run.conversationId,
        );
        if (existing === undefined || run.conversationRunNumber < existing.runCount) {
          return currentStateValue;
        }
        return {
          ...currentStateValue,
          conversations: currentStateValue.conversations.map((conversation) =>
            conversation.id === run.conversationId
              ? {
                  ...conversation,
                  latestRun: { id: run.id, status: run.status },
                  runCount: run.conversationRunNumber,
                  updatedAt: run.completedAt ?? run.startedAt,
                }
              : conversation,
          ),
        };
      });
    },
    [organizationId, scopeKey],
  );

  return {
    conversations: currentState.conversations,
    error: currentState.error,
    loading: currentState.loading,
    recordConversation,
    recordRun,
    refresh,
  };
}
