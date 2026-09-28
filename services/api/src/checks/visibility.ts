import type { Prisma } from '@prisma/client';

// Composite candidates (worker's app.explication.compare module docstring): a
// run of >= 2 consecutive changed rooms in one explication table is recorded
// as ONE check with its members ("atoms") nested under it via
// checks.parent_check_id, so an inspector cannot decide on part of a run
// without splitting it first (POST /api/v1/findings/:id/split).
//
// The visibility rule this constant encodes:
//   - an atom (parent_check_id set) is visible only once its parent's
//     split_at is set - before that it is not a finding of its own yet;
//   - a composite (parent_check_id null) is visible only while its own
//     split_at is still null - once split, its row is superseded by its
//     atoms and hides in turn.
// An ordinary, atomic check (parent_check_id null, never split) is always
// visible, same as before composites existed.
//
// Every route that lists or counts checks must filter through this constant
// rather than reinventing the rule, so an unsplit composite counts as
// exactly the one candidate it is everywhere at once - see
// routes/protocols.ts, dashboard.ts, objects.ts, processes.ts,
// suspicions.ts, verdicts.ts (export.ts inherits it via loadProtocolResponse).
export const visibleCheckWhere: Prisma.CheckWhereInput = {
  OR: [
    { parentCheckId: null, splitAt: null },
    { parentCheckId: { not: null }, parent: { splitAt: { not: null } } },
  ],
};

// The same rule as visibleCheckWhere above, applied in memory to an already
// fetched array instead of the live table - for a superseded protocol's
// snapshot (routes/protocols.ts), whose checks no longer exist in `checks`
// by the time anyone reads them back. Takes the FULL row set of the process
// at snapshot time (composites and their atoms alike), not a pre-filtered
// one - an atom's visibility depends on its parent's own splitAt, which must
// still be in the list to look up.
export function filterVisibleChecks<T extends { id: string; parentCheckId: string | null; splitAt: Date | null }>(
  checks: T[],
): T[] {
  const splitAtById = new Map(checks.map((check) => [check.id, check.splitAt]));
  return checks.filter((check) => {
    if (check.parentCheckId === null) return check.splitAt === null;
    const parentSplitAt = splitAtById.get(check.parentCheckId);
    return parentSplitAt !== undefined && parentSplitAt !== null;
  });
}
