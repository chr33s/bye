// Local threading (E11, §4.2). References/In-Reply-To are untrusted metadata and are only
// matched against messages already inside the same authorized mailbox.

const REPLY_PREFIX =
  /^\s*(?:(?:re|fwd?|aw|sv|antw|vs|wg|tr|r|rif|odp|res)(?:\s*\[\d+\])?\s*[:：]|\[[^\]]{1,60}\])\s*/i;

export const normalizeSubject = (subject: string): string => {
  let current = subject.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 20; i++) {
    const next = current.replace(REPLY_PREFIX, "");
    if (next === current) break;
    current = next;
  }
  return current.trim().toLowerCase();
};

export const hasReplyPrefix = (subject: string): boolean =>
  /^\s*(?:re|fwd?|aw|sv|antw|vs|wg|tr|r|rif|odp|res)(?:\s*\[\d+\])?\s*[:：]/i.test(
    subject.replace(/^\s*(\[[^\]]{1,60}\]\s*)+/, ""),
  );

export interface ThreadCandidate {
  readonly messageIdHeader: string | undefined;
  readonly inReplyTo: ReadonlyArray<string>;
  readonly references: ReadonlyArray<string>;
  readonly subject: string;
  /** Normalized participant addresses (from/to/cc). */
  readonly participants: ReadonlyArray<string>;
  readonly date: number;
}

export interface ThreadSubjectEntry {
  readonly threadId: string;
  readonly participants: ReadonlyArray<string>;
  readonly lastDate: number;
}

export interface ThreadIndex {
  readonly byMessageId: (messageId: string) => string | undefined;
  readonly bySubject: (normalizedSubject: string) => ReadonlyArray<ThreadSubjectEntry>;
}

export interface ThreadMatch {
  readonly threadId: string;
  readonly via: "in-reply-to" | "references" | "subject";
}

export const DEFAULT_SUBJECT_WINDOW_MS = 14 * 24 * 3600 * 1000;
const MAX_REFERENCES_CHECKED = 100;

/**
 * Resolve an existing local thread for an incoming or outgoing message. Header matches take
 * precedence; subject fallback requires a reply prefix, participant overlap, and a time window.
 */
export const resolveThread = (
  candidate: ThreadCandidate,
  index: ThreadIndex,
  options: { readonly windowMs?: number } = {},
): ThreadMatch | undefined => {
  for (const id of candidate.inReplyTo) {
    const threadId = index.byMessageId(id);
    if (threadId) return { threadId, via: "in-reply-to" };
  }
  const refs = candidate.references.slice(-MAX_REFERENCES_CHECKED);
  for (let i = refs.length - 1; i >= 0; i--) {
    const threadId = index.byMessageId(refs[i]!);
    if (threadId) return { threadId, via: "references" };
  }
  if (!hasReplyPrefix(candidate.subject)) return undefined;
  const normalized = normalizeSubject(candidate.subject);
  if (normalized.length < 3) return undefined;
  const window = options.windowMs ?? DEFAULT_SUBJECT_WINDOW_MS;
  const participants = new Set(candidate.participants.map((p) => p.toLowerCase()));
  const matches = index
    .bySubject(normalized)
    .filter(
      (e) =>
        Math.abs(candidate.date - e.lastDate) <= window &&
        e.participants.some((p) => participants.has(p.toLowerCase())),
    )
    .sort((a, b) => b.lastDate - a.lastDate);
  const best = matches[0];
  return best ? { threadId: best.threadId, via: "subject" } : undefined;
};

/** References header for a reply: parent's references plus parent ID, bounded to avoid unbounded growth. */
export const replyReferences = (
  parent: {
    readonly messageIdHeader: string | undefined;
    readonly references: ReadonlyArray<string>;
  },
  max = 20,
): Array<string> => {
  const refs = [...parent.references];
  if (parent.messageIdHeader) refs.push(parent.messageIdHeader);
  if (refs.length <= max) return refs;
  // Keep the root and the most recent ancestors (RFC 5322 §3.6.4 guidance).
  return [refs[0]!, ...refs.slice(refs.length - (max - 1))];
};
