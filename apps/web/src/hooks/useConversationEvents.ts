'use client';

import { ZappApiError, type RunEvent } from '@zapp/api-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createControlPlaneClient,
  type BuilderRun,
  type ProjectConversationEvent,
} from '../lib/api';
import { useRunEvents, type RunEventConnection } from './useRunEvents';

const pageSize = 100;
const noRunEvents: readonly RunEvent[] = [];

export type ConversationRunEvent = RunEvent & { readonly runNumber: number };

export interface ConversationEventsState {
  readonly connection: RunEventConnection;
  readonly error: string | undefined;
  readonly events: readonly ConversationRunEvent[];
  readonly loading: boolean;
  readonly liveEvents: readonly RunEvent[];
  readonly refresh: () => void;
}

interface ConversationHistoryState {
  readonly error: string | undefined;
  readonly history: readonly ConversationRunEvent[];
  readonly loading: boolean;
  readonly scopeKey: string;
}

function emptyHistoryState(scopeKey: string, loading: boolean): ConversationHistoryState {
  return { error: undefined, history: [], loading, scopeKey };
}

function asRunEvent(item: ProjectConversationEvent): ConversationRunEvent {
  return {
    data: item.event,
    id: String(item.event.sequence),
    runNumber: item.runNumber,
    type: item.event.type,
  };
}

function eventKey(event: RunEvent): string {
  return `${event.data.runId}:${String(event.data.sequence)}`;
}

export function useConversationEvents(
  conversationId: string | undefined,
  activeRun: BuilderRun | undefined,
  organizationId: string,
): ConversationEventsState {
  const scopeKey = `${organizationId}:${conversationId ?? 'none'}`;
  const [state, setState] = useState<ConversationHistoryState>(() =>
    emptyHistoryState(scopeKey, conversationId !== undefined),
  );
  const [refreshToken, setRefreshToken] = useState(0);
  const generationRef = useRef(0);
  const currentState =
    state.scopeKey === scopeKey
      ? state
      : emptyHistoryState(scopeKey, conversationId !== undefined);
  const scopedActiveRun =
    activeRun?.organizationId === organizationId && activeRun.conversationId === conversationId
      ? activeRun
      : undefined;
  const { connection, events: unscopedLiveEvents } = useRunEvents(
    scopedActiveRun?.id,
    organizationId,
  );
  const liveEvents = scopedActiveRun === undefined ? noRunEvents : unscopedLiveEvents;

  useEffect(() => {
    if (conversationId === undefined) {
      generationRef.current += 1;
      setState(emptyHistoryState(scopeKey, false));
      return;
    }

    const controller = new AbortController();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setState(emptyHistoryState(scopeKey, true));

    const load = async (): Promise<void> => {
      try {
        const client = createControlPlaneClient(organizationId);
        const items: ProjectConversationEvent[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listConversationEvents(
            conversationId,
            { ...(cursor === undefined ? {} : { cursor }), limit: pageSize },
            controller.signal,
          );
          items.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        if (controller.signal.aborted || generationRef.current !== generation) return;
        setState({
          error: undefined,
          history: items.map(asRunEvent),
          loading: false,
          scopeKey,
        });
      } catch (error) {
        if (!controller.signal.aborted && generationRef.current === generation) {
          if (
            error instanceof ZappApiError &&
            error.status === 404
          ) {
            setState({ error: undefined, history: [], loading: false, scopeKey });
            return;
          }
          setState({
            error: 'This conversation could not be loaded.',
            history: [],
            loading: false,
            scopeKey,
          });
        }
      }
    };

    void load();
    return () => {
      controller.abort();
    };
  }, [conversationId, organizationId, refreshToken, scopeKey]);

  const refresh = useCallback((): void => {
    setRefreshToken((current) => current + 1);
  }, []);

  const events = useMemo(() => {
    const merged = new Map<string, ConversationRunEvent>();
    for (const event of currentState.history) merged.set(eventKey(event), event);
    if (scopedActiveRun !== undefined) {
      for (const event of liveEvents) {
        merged.set(eventKey(event), {
          ...event,
          runNumber: scopedActiveRun.conversationRunNumber,
        });
      }
    }
    return [...merged.values()].sort(
      (left, right) =>
        left.runNumber - right.runNumber || left.data.sequence - right.data.sequence,
    );
  }, [currentState.history, liveEvents, scopedActiveRun]);

  return {
    connection: scopedActiveRun === undefined ? 'idle' : connection,
    error: currentState.error,
    events,
    liveEvents,
    loading: currentState.loading,
    refresh,
  };
}
