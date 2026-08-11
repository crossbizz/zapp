'use client';

import type { RunEvent } from '@zapp/api-client';
import { useEffect, useState } from 'react';

import { createControlPlaneClient } from '../lib/api';

const maximumCachedEvents = 1_000;

export type RunEventConnection = 'connecting' | 'connected' | 'idle' | 'reconnecting';

export interface RunEventsState {
  readonly connection: RunEventConnection;
  readonly events: readonly RunEvent[];
}

function cacheKey(runId: string): string {
  return `zapp:run-events:${runId}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCachedEvent(value: unknown, runId: string): value is RunEvent {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['type'] !== 'string') {
    return false;
  }
  const data = value['data'];
  return (
    isRecord(data) &&
    data['runId'] === runId &&
    data['type'] === value['type'] &&
    typeof data['sequence'] === 'number' &&
    Number.isSafeInteger(data['sequence']) &&
    data['sequence'] >= 0 &&
    value['id'] === String(data['sequence'])
  );
}

function readCache(runId: string): readonly RunEvent[] {
  try {
    const raw = localStorage.getItem(cacheKey(runId));
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is RunEvent => isCachedEvent(value, runId))
      .sort((left, right) => left.data.sequence - right.data.sequence)
      .slice(-maximumCachedEvents);
  } catch {
    return [];
  }
}

function writeCache(runId: string, events: readonly RunEvent[]): void {
  try {
    localStorage.setItem(cacheKey(runId), JSON.stringify(events.slice(-maximumCachedEvents)));
  } catch {
    // The live stream remains authoritative when browser storage is unavailable.
  }
}

function mergeEvent(events: readonly RunEvent[], incoming: RunEvent): readonly RunEvent[] {
  if (events.some((event) => event.data.sequence === incoming.data.sequence)) return events;
  return [...events, incoming]
    .sort((left, right) => left.data.sequence - right.data.sequence)
    .slice(-maximumCachedEvents);
}

export function useRunEvents(runId: string | undefined, organizationId: string): RunEventsState {
  const [connection, setConnection] = useState<RunEventConnection>(
    runId === undefined ? 'idle' : 'connecting',
  );
  const [events, setEvents] = useState<readonly RunEvent[]>([]);

  useEffect(() => {
    if (runId === undefined) {
      setEvents([]);
      setConnection('idle');
      return;
    }

    let currentEvents = readCache(runId);
    let current = true;
    setEvents(currentEvents);
    setConnection('connecting');
    const latest = currentEvents.at(-1)?.data.sequence;
    const subscription = createControlPlaneClient(organizationId).subscribeRunEvents(runId, {
      ...(latest === undefined ? {} : { after: latest }),
      onError() {
        if (current) setConnection('reconnecting');
      },
      onEvent(event) {
        if (!current || event.data.visibility !== 'user') return;
        currentEvents = mergeEvent(currentEvents, event);
        writeCache(runId, currentEvents);
        setEvents(currentEvents);
        setConnection('connected');
      },
    });

    void subscription.closed.catch(() => {
      if (current) setConnection('reconnecting');
    });
    return () => {
      current = false;
      subscription.close();
    };
  }, [organizationId, runId]);

  return { connection, events };
}
