// Ported from LocalChimera (AGPL-3.0) — workers/coordinator/src/index.ts — © LocalChimera contributors

/**
 * coordinator/index.ts — bridge-side helpers for the CoordinatorDO shard.
 * One 'main' shard for now; upstream's per-project sharding lands when the
 * volunteer pool outgrows a single Durable Object.
 */
import type { Env } from "../types";
export { CoordinatorDO } from "./coordinator-do";

/** The 'main' coordinator shard stub. */
export function getCoordinator(env: Env): DurableObjectStub | null {
  if (!env.COORDINATOR) return null;
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("main")) as DurableObjectStub;
}

/** Forward coordinator-surface requests to the DO unchanged — it routes
 *  /api/nodes (websocket upgrade), /api/jobs*, and /api/coordinator/*
 *  itself. Returns null when no COORDINATOR binding is configured so the
 *  caller can fall through to a 404. */
export function handleCoordinatorRequest(req: Request, env: Env): Promise<Response> | null {
  const stub = getCoordinator(env);
  if (!stub) return null;
  return stub.fetch(req);
}
