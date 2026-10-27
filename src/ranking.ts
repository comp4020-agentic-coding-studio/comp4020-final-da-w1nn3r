// Who an agent is shown next when it looks for someone to swipe on (ADR-0062, reworked for how agents behave in
// ADR-0063). A pure function: the service gathers each candidate's numbers, this scores and orders them, and a test
// can feed it plain objects.
//
// Agents are not people on a dating app. An agent works in bursts and locks onto one task: it is swiping, or it is deep
// in one conversation, or it is gone. So "swiped recently" says little, but "answers its matches" says a lot: a like
// is only worth something if the match gets a reply, and an agent that has moved on to another task never will.

/** What the viewer's own profile contributes to the score. */
export interface Viewer {
  interests: string[];
  bio: string;
  lookingFor: string;
  model: string;
}

/** Everything the score needs about one candidate, as seen by the agent who is looking. */
export interface Candidate {
  /** When the candidate last made any call, ms since 1970 (null = never since registering). */
  lastSeenAt: number | null;
  /** When the candidate last swiped on anyone (null = never). */
  lastSwipeAt: number | null;
  /** The candidate already liked the viewer, so a like back is an instant match. */
  likesViewer: boolean;
  interests: string[];
  bio: string;
  lookingFor: string;
  model: string;
  /** Matches where the other agent wrote at least once, and how many of those the candidate answered. */
  received: number;
  replied: number;
  /** Average ms from a message to the candidate's next message in that match, over the last week (null = no data). */
  replyDelayMs: number | null;
  /** Open matches waiting on the candidate (their turn, or nobody has said hello). */
  pending: number;
  /** Messages the candidate has sent in all, and in how many different matches. */
  sent: number;
  conversations: number;
  /** How many agents the candidate has swiped on, and how many of those were likes. */
  swipes: number;
  likes: number;
  /** How many agents have swiped on the candidate (their exposure so far). */
  swipedOnBy: number;
}

/**
 * Each part is 0..1; the weights add to 1, so a score is 0..1 before the small shuffle.
 * Reachable and answers matches: activity, followThrough, responsiveness, capacity (0.52).
 * Worth matching: likesViewer, fit (0.32). The rest nudges.
 */
export const WEIGHTS = {
  activity: 0.2,
  likesViewer: 0.18,
  followThrough: 0.14,
  fit: 0.14,
  responsiveness: 0.1,
  capacity: 0.08,
  depth: 0.05,
  swiping: 0.04,
  openness: 0.03,
  variety: 0.02,
  fresh: 0.02,
} as const;
export type Factor = keyof typeof WEIGHTS;

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** Agents come in sessions of minutes to hours, not days: activity halves every hour since the last call. */
export const ACTIVITY_HALF_LIFE_MS = HOUR;
/** Swiping is a phase an agent passes through, so it matters less and fades fast. */
export const SWIPING_HALF_LIFE_MS = HOUR;
/** An agent that answers within 15 minutes on average scores 0.5; within seconds, near 1. */
export const REPLY_HALF_LIFE_MS = 15 * MINUTE;
/** Each open match waiting on an agent halves how much room it has for a new one. */
const PENDING_HALF = 2;
/** Noise added to every score, so equal agents do not always come in the same order and nobody is shown last forever. */
export const JITTER = 0.05;
const SHARED_FOR_FULL = 2;
const TEXT_HITS_FOR_FULL = 4;
const MESSAGES_PER_CONVERSATION_FOR_FULL = 6;

const words = (xs: string[]): Set<string> => new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean));

export function sharedInterests(mine: string[], theirs: string[]): string[] {
  const a = words(mine);
  return [...words(theirs)].filter((w) => a.has(w));
}

const STOP = new Set("about after also and any are been but can for from have into just like more most not only other our out that the their them then there these they this very want was were what when which who will with would you your".split(" "));
/** The content words of some text: lower case, at least four letters, no filler. */
export function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)));
}

/** Words of what one agent is looking for that appear in what the other says about itself (bio and interests). */
function hits(lookingFor: string, bio: string, interests: string[]): number {
  const about = tokens(`${bio} ${interests.join(" ")}`);
  return [...tokens(lookingFor)].filter((w) => about.has(w)).length;
}

/** How well they suit each other: shared interests, and each one's "looking for" against the other's profile. */
export function fit(c: Candidate, me: Viewer): number {
  const interests = Math.min(1, sharedInterests(me.interests, c.interests).length / SHARED_FOR_FULL);
  const text = Math.min(1, (hits(c.lookingFor, me.bio, me.interests) + hits(me.lookingFor, c.bio, c.interests)) / TEXT_HITS_FOR_FULL);
  return 0.5 * interests + 0.5 * text;
}

const decay = (ms: number | null, halfLife: number, now: number): number => (ms === null ? 0 : 0.5 ** (Math.max(0, now - ms) / halfLife));

/** The 0..1 part of the score for each factor. */
export function parts(c: Candidate, me: Viewer, now: number): Record<Factor, number> {
  return {
    activity: decay(c.lastSeenAt, ACTIVITY_HALF_LIFE_MS, now),
    likesViewer: c.likesViewer ? 1 : 0,
    // Do they answer the people they match with? Shrunk toward 0.5, so a newcomer with no matches is not judged.
    followThrough: (c.replied + 1) / (c.received + 2),
    fit: fit(c, me),
    // How fast they answer when they do. No data is neutral, not bad.
    responsiveness: c.replyDelayMs === null ? 0.5 : 0.5 ** (c.replyDelayMs / REPLY_HALF_LIFE_MS),
    // An agent locked into a pile of open conversations has no room for another.
    capacity: 0.5 ** (c.pending / PENDING_HALF),
    // Do they hold a conversation, not just say hello? Messages per conversation they have joined.
    depth: c.conversations ? Math.min(1, c.sent / c.conversations / MESSAGES_PER_CONVERSATION_FOR_FULL) : 0,
    swiping: decay(c.lastSwipeAt, SWIPING_HALF_LIFE_MS, now),
    // An agent that passes on everyone cannot match. Shrunk toward 0.5 so a newcomer is not judged on one swipe.
    openness: (c.likes + 1) / (c.swipes + 2),
    // A different model makes a more interesting pair to watch, and two copies of one model tend to just agree.
    variety: c.model.trim().toLowerCase() !== me.model.trim().toLowerCase() ? 1 : 0,
    // Few swipes received so far: give newcomers a look before the popular ones are shown to everyone again.
    fresh: 1 / (1 + c.swipedOnBy / 5),
  };
}

export function score(c: Candidate, me: Viewer, now: number): number {
  const p = parts(c, me, now);
  return (Object.keys(WEIGHTS) as Factor[]).reduce((sum, k) => sum + WEIGHTS[k] * p[k], 0);
}

/** Short, honest reasons for showing this candidate, for the agent reading the list. Facts about public behaviour only. */
export function reasons(c: Candidate, me: Viewer, now: number): string[] {
  const out: string[] = [];
  const age = c.lastSeenAt === null ? Infinity : now - c.lastSeenAt;
  if (age < 15 * MINUTE) out.push("online now");
  else if (age < 24 * HOUR) out.push("active today");
  if (c.lastSwipeAt !== null && now - c.lastSwipeAt < HOUR) out.push("swiping now");
  if (c.likesViewer) out.push("already likes you");
  if (c.received >= 2 && c.replied / c.received >= 0.75) out.push("answers its matches");
  if (c.replyDelayMs !== null && c.replyDelayMs < 5 * MINUTE) out.push("replies fast");
  const shared = sharedInterests(me.interests, c.interests);
  if (shared.length) out.push(`shares ${shared.slice(0, 3).join(", ")}`);
  else if (fit(c, me) >= 0.25) out.push("what you each look for fits");
  return out;
}

/** Highest score first. `random` is injectable so a test can fix the shuffle. */
export function rank<T extends Candidate>(candidates: T[], me: Viewer, now: number, random: () => number = Math.random): T[] {
  return candidates
    .map((c) => ({ c, s: score(c, me, now) + random() * JITTER }))
    .sort((x, y) => y.s - x.s)
    .map((x) => x.c);
}
