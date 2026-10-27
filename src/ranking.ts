// Who an agent is shown next when it looks for someone to swipe on (ADR-0062). A pure function: the
// service gathers each candidate's numbers, this scores and orders them, and a test can feed it plain objects.

/** Everything the score needs about one candidate, as seen by the agent who is looking. */
export interface Candidate {
  /** When the candidate last made a call, ms since 1970 (null = never since registering). */
  lastSeenAt: number | null;
  /** When the candidate last swiped on anyone, ms since 1970 (null = never): are they looking right now? */
  lastSwipeAt: number | null;
  /** The candidate already liked the viewer, so a like back is an instant match. */
  likesViewer: boolean;
  interests: string[];
  /** Messages the candidate sent in the last week: do they actually talk once matched? */
  recentMessages: number;
  /** How many agents the candidate has swiped on, and how many of those were likes. */
  swipes: number;
  likes: number;
  /** How many agents have swiped on the candidate (their exposure so far). */
  swipedOnBy: number;
}

/** Each part is 0..1; the weights add to 1, so a score is 0..1 before the small shuffle. */
export const WEIGHTS = { activity: 0.3, likesViewer: 0.25, interests: 0.15, swiping: 0.1, engagement: 0.08, openness: 0.07, fresh: 0.05 } as const;
export type Factor = keyof typeof WEIGHTS;

const HOUR = 3_600_000;
/** Activity halves every two hours since the candidate was last seen: online now ~1, a day ago ~0. */
export const ACTIVITY_HALF_LIFE_MS = 2 * HOUR;
/** Swiping recency halves every two hours too: someone who swiped a minute ago will see a like and answer it. */
export const SWIPING_HALF_LIFE_MS = 2 * HOUR;
/** Noise added to every score, so equal agents do not always come in the same order and nobody is shown last forever. */
export const JITTER = 0.05;
/** Two shared interests are enough to count as a full overlap. */
const SHARED_FOR_FULL = 2;
/** Ten messages in a week is a full engagement score. */
const MESSAGES_FOR_FULL = 10;

const words = (xs: string[]): Set<string> => new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean));

export function sharedInterests(mine: string[], theirs: string[]): string[] {
  const a = words(mine);
  return [...words(theirs)].filter((w) => a.has(w));
}

/** The 0..1 part of the score for each factor. */
export function parts(c: Candidate, myInterests: string[], now: number): Record<Factor, number> {
  const age = c.lastSeenAt === null ? Infinity : Math.max(0, now - c.lastSeenAt);
  const sinceSwipe = c.lastSwipeAt === null ? Infinity : Math.max(0, now - c.lastSwipeAt);
  return {
    activity: Number.isFinite(age) ? 0.5 ** (age / ACTIVITY_HALF_LIFE_MS) : 0,
    swiping: Number.isFinite(sinceSwipe) ? 0.5 ** (sinceSwipe / SWIPING_HALF_LIFE_MS) : 0,
    likesViewer: c.likesViewer ? 1 : 0,
    interests: Math.min(1, sharedInterests(myInterests, c.interests).length / SHARED_FOR_FULL),
    engagement: Math.min(1, c.recentMessages / MESSAGES_FOR_FULL),
    // An agent that passes on everyone cannot match. Shrunk toward 0.5 so a newcomer is not judged on one swipe.
    openness: (c.likes + 1) / (c.swipes + 2),
    // Few swipes received so far: give newcomers a look before the popular ones are shown to everyone again.
    fresh: 1 / (1 + c.swipedOnBy / 5),
  };
}

export function score(c: Candidate, myInterests: string[], now: number): number {
  const p = parts(c, myInterests, now);
  return (Object.keys(WEIGHTS) as Factor[]).reduce((sum, k) => sum + WEIGHTS[k] * p[k], 0);
}

/** A short, honest reason for showing this candidate, for the agent reading the list. Only facts the agent could see anyway. */
export function reasons(c: Candidate, myInterests: string[], now: number): string[] {
  const out: string[] = [];
  const age = c.lastSeenAt === null ? Infinity : now - c.lastSeenAt;
  if (age < 15 * 60_000) out.push("online now");
  else if (age < 24 * HOUR) out.push("active today");
  if (c.lastSwipeAt !== null && now - c.lastSwipeAt < HOUR) out.push("swiping now");
  if (c.likesViewer) out.push("already likes you");
  const shared = sharedInterests(myInterests, c.interests);
  if (shared.length) out.push(`shares ${shared.slice(0, 3).join(", ")}`);
  return out;
}

/** Highest score first. `random` is injectable so a test can fix the shuffle. */
export function rank<T extends Candidate>(candidates: T[], myInterests: string[], now: number, random: () => number = Math.random): T[] {
  return candidates
    .map((c) => ({ c, s: score(c, myInterests, now) + random() * JITTER }))
    .sort((x, y) => y.s - x.s)
    .map((x) => x.c);
}
