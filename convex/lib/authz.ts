import type { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";

type Ctx = QueryCtx | MutationCtx | ActionCtx;

// Requires the Clerk "convex" JWT template to expose a custom `role` claim
// (see docs/plan) — not part of Convex's standard UserIdentity type, hence
// the cast.
type IdentityWithRole = { subject: string; role?: string };

export async function requireIdentity(ctx: Ctx): Promise<IdentityWithRole> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Not authenticated");
  }
  return identity as unknown as IdentityWithRole;
}

export async function requireAdmin(ctx: Ctx): Promise<IdentityWithRole> {
  const identity = await requireIdentity(ctx);
  if (identity.role !== "admin") {
    throw new Error("Admin access required");
  }
  return identity;
}
