/**
 * Who may pause or delete one recurring rule (finance-planning-013).
 *
 * The rule has always been "its creator, or an admin" — the same shape as
 * deleting a transaction, and a sound one while the creator is still around.
 * `removeUserAction` tombstones a departing teammate's User row and touches
 * nothing else, and CLAUDE.md records that there is deliberately no
 * individual-user purge: so once they are gone, that tombstone and their rules
 * are permanent, and the only person the gate names can never sign in again. A
 * co-founder with full finance access was left looking at a standing charge with
 * no Pause and no Delete on the card.
 *
 * So there is one more way in, and only one: when the AUTHOR IS GONE, anyone the
 * finance boundary already admits may act. That is not "any finance user may
 * manage any rule" — a permission change of that size is a product decision, and
 * the creator-or-admin rule is untouched for every rule whose author is still
 * here. It is "when there is nobody left to ask, the people who own the books
 * may clear it up".
 *
 * ONE STATEMENT, TWO LAYERS. `toggleRecurringRuleAction` /
 * `deleteRecurringRuleAction` enforce it and app/(app)/recurring's RuleCard
 * decides whether to render the controls at all; CLAUDE.md asks those two to
 * agree, and a mirrored expression is how they stop agreeing. Pure data, no I/O,
 * no server imports — safe to import from the client component.
 *
 * NOT A SUBSTITUTE FOR THE TENANT CHECK. Both callers compare
 * `rule.companyId` to the session's company BEFORE asking this, and must keep
 * doing so: a removed author must never be a way into another workspace's rules.
 * This function is handed no company at all, so it cannot make that mistake and
 * cannot be mistaken for having made it.
 */

import { canSeeFinances, type Role } from "@/lib/auth/role-gates";

export interface ManageableRule {
  /** `RecurringRule.addedBy` — the userId that created it. */
  addedBy: string;
  /** True when that user's row carries a `deletedAt` (deactivated teammate). */
  authorRemoved: boolean;
}

export interface RuleViewer {
  id: string;
  role: Role;
}

export function canManageRecurringRule(rule: ManageableRule, viewer: RuleViewer): boolean {
  if (rule.addedBy === viewer.id) return true;
  if (viewer.role === "admin") return true;
  // The orphan case. `canSeeFinances` rather than a bare `cofounder` comparison,
  // for the reason lib/queries/session.ts gives: a role nobody has heard of —
  // one invented by a tampered cookie, or added to role-gates.ts next quarter —
  // must fail closed here rather than slide past a string comparison.
  return rule.authorRemoved && canSeeFinances(viewer.role);
}
