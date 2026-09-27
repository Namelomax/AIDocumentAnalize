// Colour indicator for a construction object on the dashboard. Section 7 of
// the specification names the indicator but leaves its rule undefined; the
// table comes from Plan 7 instead. Kept as a pure function, free of Prisma,
// so the three colours (and the "not checked yet" case) are tested without a
// database.
export interface LatestProtocolForIndicator {
  status: string;
  confirmed: number;
  candidates: number;
  clarifications: number;
}

export type ObjectIndicator = 'green' | 'yellow' | 'red';

const VERIFIED_STATUSES = new Set(['VERIFICATION_COMPLETED', 'PROTOCOL_FINALIZED']);

export function indicatorFor(latest: LatestProtocolForIndicator | null): ObjectIndicator {
  // No protocol at all yet: the object was never checked.
  if (!latest) return 'yellow';

  // A confirmed violation always wins, whatever else is still open.
  if (latest.confirmed > 0) return 'red';

  // Undecided candidates or open clarification requests: the inspector still
  // has work to do on this object.
  if (latest.candidates > 0 || latest.clarifications > 0) return 'yellow';

  // Nothing left to decide and no violation was confirmed - green only once
  // the protocol itself is actually verified or finalized, not merely
  // produced by the engine (status READY).
  if (VERIFIED_STATUSES.has(latest.status)) return 'green';

  return 'yellow';
}
