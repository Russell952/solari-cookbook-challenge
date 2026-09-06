/**
 * SSE event emitter for investigation progress.
 *
 * Clients subscribe to /api/investigations/:id/events
 * and receive real-time updates as the investigation progresses.
 */
import type { Response } from "express";
import type { SSEEvent, SSEEventType } from "@probe/shared";

// Map of investigationId → set of response connections
const subscribers = new Map<string, Set<Response>>();

export function subscribe(investigationId: string, res: Response): void {
  if (!subscribers.has(investigationId)) {
    subscribers.set(investigationId, new Set());
  }
  subscribers.get(investigationId)!.add(res);

  res.on("close", () => {
    subscribers.get(investigationId)?.delete(res);
    if (subscribers.get(investigationId)?.size === 0) {
      subscribers.delete(investigationId);
    }
  });
}

export function emit(
  type: SSEEventType,
  investigationId: string,
  data: Record<string, unknown>
): void {
  const event: SSEEvent = {
    type,
    investigationId,
    data,
    timestamp: new Date().toISOString(),
  };

  const subs = subscribers.get(investigationId);
  if (!subs || subs.size === 0) return;

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subs) {
    try {
      res.write(payload);
    } catch {
      subs.delete(res);
    }
  }
}

export function subscriberCount(investigationId: string): number {
  return subscribers.get(investigationId)?.size ?? 0;
}
