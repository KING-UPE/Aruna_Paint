import type { PermissionSet } from '@aruna/shared';

/** Who is doing what, from where. Built from the session on every request. */
export interface RequestContext {
  sessionId: string;
  user: {
    id: string;
    username: string;
    fullName: string;
    mustChangePassword: boolean;
  };
  roleCodes: string[];
  permissions: PermissionSet;
  counter: { id: string; code: string; name: string; locationId: string } | null;
  /** The counter's location, or the main shop for PCs that aren't counters. */
  locationId: string;
  ip: string;
}

/** For jobs that run without a person (nightly backup, scheduled alerts). */
export interface ActorRef {
  userId: string | null;
  counterId?: string | null;
  ip?: string;
}

export function actorOf(ctx: RequestContext): ActorRef {
  return { userId: ctx.user.id, counterId: ctx.counter?.id ?? null, ip: ctx.ip };
}
