import type { PermissionSet } from '@aruna/shared';

/** Who is doing what, from where. Built from the session on every request. */
export interface RequestContext {
  sessionId: string;
  user: {
    id: string;
    username: string;
    fullName: string;
    mustChangePassword: boolean;
    /** The owner: the one top Super Admin, at every shop. */
    owner: boolean;
  };
  roleCodes: string[];
  permissions: PermissionSet;
  /** The shop's location: bills and returns move its stock. Every PC is the same (no counters). */
  locationId: string;
  ip: string;
  /** This user works on the test copy (set by the Super Admin). */
  testMode: boolean;
}

/** For jobs that run without a person (nightly backup, scheduled alerts). */
export interface ActorRef {
  userId: string | null;
  ip?: string;
}

export function actorOf(ctx: RequestContext): ActorRef {
  return { userId: ctx.user.id, ip: ctx.ip };
}
