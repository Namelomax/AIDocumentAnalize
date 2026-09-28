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
