import { domainOf, normalizeAddress, timingSafeEqual } from "@bye/domain";
import type { MessageSummary } from "@bye/mail-codec";
import { Schema } from "effect";
import { type MailboxContext, reject } from "./context.ts";
import type { IdentityDirectory } from "./identities.ts";
import type { MailboxSends } from "./send-jobs.ts";

export type MailboxAwaySettings = {
  readonly enabled: boolean;
  readonly startAt: number | null;
  readonly endAt: number | null;
  readonly subject: string;
  readonly text: string;
  /** Per-sender cooldown; default 4 days. */
  readonly cooldownMs: number;
};

export type MailboxNotificationSettings = {
  /** Quiet by default: only opted-in contacts/domains/threads notify (E23). */
  readonly quietHours: {
    readonly start: string;
    readonly end: string;
    readonly timeZone: string;
  } | null;
  readonly devices: Readonly<Record<string, { readonly enabled: boolean }>>;
};

export type MailboxPreferenceKey =
  | "theme"
  | "shortcuts"
  | "remoteImages"
  | "recycling"
  | "undoWindowMs"
  | "density"
  | "calendarPanel"
  | "coverArt";

const PREFERENCE_SCHEMAS = {
  theme: Schema.Literals(["light", "dark", "system"]),
  shortcuts: Schema.Boolean,
  remoteImages: Schema.Literals(["proxy", "off"]),
  recycling: Schema.Struct({
    days: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(30))),
  }),
  undoWindowMs: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })),
  density: Schema.Literals(["comfortable", "compact"]),
  calendarPanel: Schema.Boolean,
  coverArt: Schema.String.check(Schema.isMaxLength(511)),
} satisfies Record<MailboxPreferenceKey, Schema.Top>;

/** The validated presentation preferences of one mailbox. */
export type MailboxPreferences = {
  readonly [K in MailboxPreferenceKey]: (typeof PREFERENCE_SCHEMAS)[K]["Type"];
};

const DEFAULT_PREFERENCES: MailboxPreferences = {
  theme: "system",
  shortcuts: true,
  remoteImages: "proxy",
  recycling: { days: null },
  undoWindowMs: 10_000,
  density: "comfortable",
  calendarPanel: false,
  coverArt: "",
};

const MAX_FORWARD_HOPS = 5;

const DEFAULT_AWAY: MailboxAwaySettings = {
  enabled: false,
  startAt: null,
  endAt: null,
  subject: "Away",
  text: "",
  cooldownMs: 4 * 24 * 3600 * 1000,
};

/** Hour/minute formatter for an IANA zone, or null when the zone is not recognised. */
const quietHoursFormatter = (timeZone: string): Intl.DateTimeFormat | null => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
};

type MaybeForwardResult = {
  readonly jobIds: ReadonlyArray<string>;
  readonly discardLocal: boolean;
};

type AddForwardingDestinationResult = { readonly sendJobId: string };

/** Away replies, forwarding, notification preferences, and presentation settings (E22–E24). */
export class MailboxAutomation {
  constructor(
    private readonly ctx: MailboxContext,
    private readonly identities: IdentityDirectory,
    private readonly sends: Pick<MailboxSends, "createSystemJob" | "createForwardJob">,
  ) {}

  private get sql() {
    return this.ctx.sql;
  }

  // ------------------------------------------------------------ preferences (E23/E24)

  setPreference(key: MailboxPreferenceKey, value: Schema.Json): void {
    if (!Object.hasOwn(PREFERENCE_SCHEMAS, key)) reject("bad_request", "unknown preference");

    if (!Schema.is(PREFERENCE_SCHEMAS[key])(value))
      reject("bad_request", `invalid value for ${key}`);
    this.ctx.putSetting(`pref:${key}`, value);
    this.ctx.change("settings", "preference", { key });
  }

  preferences(): MailboxPreferences {
    const stored = <K extends MailboxPreferenceKey>(key: K): MailboxPreferences[K] =>
      this.ctx.setting(`pref:${key}`, DEFAULT_PREFERENCES[key]);

    return {
      theme: stored("theme"),
      shortcuts: stored("shortcuts"),
      remoteImages: stored("remoteImages"),
      recycling: stored("recycling"),
      undoWindowMs: stored("undoWindowMs"),
      density: stored("density"),
      calendarPanel: stored("calendarPanel"),
      coverArt: stored("coverArt"),
    };
  }

  // ------------------------------------------------------------ recent searches (E21)

  recordSearch(query: string): void {
    const q = query.trim().slice(0, 256);

    if (!q) return;
    const recent = this.ctx.setting<Array<string>>("recentSearches", []).filter((x) => x !== q);
    this.sql.tx(() => this.ctx.putSetting("recentSearches", [q, ...recent].slice(0, 20)));
  }

  recentSearches(): ReadonlyArray<string> {
    return this.ctx.setting<Array<string>>("recentSearches", []);
  }

  clearRecentSearches(): void {
    this.ctx.putSetting("recentSearches", []);
  }

  // ------------------------------------------------------------ notifications (E23)

  setNotificationSettings(settings: MailboxNotificationSettings): void {
    if (
      settings.quietHours &&
      !(
        /^\d{2}:\d{2}$/.test(settings.quietHours.start) &&
        /^\d{2}:\d{2}$/.test(settings.quietHours.end)
      )
    )
      reject("bad_request", "quiet hours use HH:MM");

    if (settings.quietHours && !quietHoursFormatter(settings.quietHours.timeZone))
      reject("bad_request", "invalid time zone");
    this.ctx.putSetting("notifications", settings);
  }

  notificationSettings(): MailboxNotificationSettings {
    return this.ctx.setting<MailboxNotificationSettings>("notifications", {
      quietHours: null,
      devices: {},
    });
  }

  setNotifyOptIn(kind: "contact" | "domain" | "thread", subject: string, on: boolean): void {
    const s = kind === "thread" ? subject : normalizeAddress(subject);

    if (on)
      this.sql.run("INSERT OR IGNORE INTO notify_opt_in (kind, subject) VALUES (?, ?)", kind, s);
    else this.sql.run("DELETE FROM notify_opt_in WHERE kind = ? AND subject = ?", kind, s);
  }

  shouldNotify(input: {
    readonly threadId: string;
    readonly from: string;
    readonly notifyPolicy: boolean;
    readonly unfollowed: boolean;
  }): boolean {
    if (input.unfollowed) return false;

    const optedIn =
      input.notifyPolicy ||
      this.sql.one(
        "SELECT 1 AS x FROM notify_opt_in WHERE (kind = 'thread' AND subject = ?) OR (kind = 'contact' AND subject = ?) OR (kind = 'domain' AND subject = ?)",
        input.threadId,
        input.from,
        domainOf(input.from),
      ) !== undefined;

    return optedIn && !this.inQuietHours(this.ctx.now());
  }

  inQuietHours(now: number): boolean {
    const q = this.notificationSettings().quietHours;

    if (!q) return false;

    // Runs inside delivery commits: a bad stored zone (pre-validation data) must never throw there.
    const parts = (quietHoursFormatter(q.timeZone) ?? quietHoursFormatter("UTC")!).formatToParts(
      new Date(now),
    );

    const hh = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const mm = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    const t = hh * 60 + mm;
    const [sh, sm] = q.start.split(":").map(Number);
    const [eh, em] = q.end.split(":").map(Number);
    const start = (sh ?? 0) * 60 + (sm ?? 0);
    const end = (eh ?? 0) * 60 + (em ?? 0);

    return start <= end ? t >= start && t < end : t >= start || t < end;
  }

  // ------------------------------------------------------------ away replies (E22)

  setAway(settings: MailboxAwaySettings): void {
    if (settings.startAt !== null && settings.endAt !== null && settings.endAt <= settings.startAt)
      reject("bad_request", "away end before start");
    this.ctx.putSetting("away", settings);
    this.sql.run("DELETE FROM away_sent");
  }

  away(): MailboxAwaySettings {
    return this.ctx.setting("away", DEFAULT_AWAY);
  }

  /**
   * Never answer empty envelope senders, automated/list traffic, spam, other away replies, or
   * ourselves; apply a per-sender cooldown and mark replies Auto-Submitted.
   */
  maybeAwayReply(input: {
    readonly threadId: string;
    readonly from: string;
    readonly recipient: string;
    readonly summary: MessageSummary;
    readonly deliveredAt: number;
  }): string | undefined {
    const a = this.away();
    const now = this.ctx.now();

    if (
      !a.enabled ||
      (a.startAt !== null && now < a.startAt) ||
      (a.endAt !== null && now >= a.endAt)
    )
      return undefined;
    const s = input.summary;
    const from = normalizeAddress(input.from);

    if (!from || !from.includes("@") || s.automated || s.listId || s.listUnsubscribe)
      return undefined;

    if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(from)) return undefined;

    if (this.identities.ownAddresses().has(from)) return undefined;

    const last = this.sql.one<{ last_sent_at: number }>(
      "SELECT last_sent_at FROM away_sent WHERE sender = ?",
      from,
    );

    if (last && now - Number(last.last_sent_at) < a.cooldownMs) return undefined;

    let systemJob: Parameters<typeof this.sends.createSystemJob>[0] = {
      to: s.from,
      subject: a.subject || `Re: ${s.subject}`,
      text: a.text,
      threadId: input.threadId,
      headers: {
        "Auto-Submitted": "auto-replied",
        "X-Auto-Response-Suppress": "All",
        Precedence: "auto_reply",
      },
      fromAddress: input.recipient,
    };

    if (s.messageIdHeader) systemJob = { ...systemJob, inReplyTo: s.messageIdHeader };
    const jobId = this.sends.createSystemJob(systemJob);

    if (jobId) {
      this.sql.run(
        "INSERT INTO away_sent (sender, last_sent_at) VALUES (?, ?) ON CONFLICT (sender) DO UPDATE SET last_sent_at = excluded.last_sent_at",
        from,
        now,
      );
    }

    return jobId;
  }

  // ------------------------------------------------------------ forwarding (E22)

  /**
   * Destinations must prove ownership before any mail is forwarded (no open relay). The code is
   * mailed to the destination as a transactional system message; it is never returned to the caller.
   */
  addForwardingDestination(address: string): AddForwardingDestinationResult {
    const a = normalizeAddress(address);

    if (this.identities.ownAddresses().has(a))
      reject("bad_request", "cannot forward to this mailbox's own address");
    const token = this.ctx.secret(8);
    this.sql.run(
      "INSERT INTO forwarding_destinations (address, token, verified, created_at) VALUES (?, ?, 0, ?) ON CONFLICT (address) DO UPDATE SET token = excluded.token, verified = 0, created_at = excluded.created_at",
      a,
      token,
      this.ctx.now(),
    );

    const sendJobId = this.sends.createSystemJob({
      to: { name: undefined, address: a },
      subject: "Confirm mail forwarding to this address",
      text: `Someone asked to forward their bye mail to ${a}.\n\nIf that was you, enter this code in bye to confirm: ${token}\n\nIf not, ignore this message; nothing will be forwarded.`,
      threadId: null,
      headers: { "Auto-Submitted": "auto-generated" },
      fromAddress: [...this.identities.ownAddresses()][0] ?? "",
      trafficClass: "transactional",
    });

    if (!sendJobId)
      reject(
        "conflict",
        "a verified sending identity is needed to verify a forwarding destination",
      );

    return { sendJobId: sendJobId! };
  }

  forwardingDestinations(): ReadonlyArray<{
    readonly address: string;
    readonly verified: boolean;
    readonly createdAt: number;
  }> {
    return this.sql
      .all<{ address: string; verified: number; created_at: number }>(
        "SELECT address, verified, created_at FROM forwarding_destinations ORDER BY address",
      )
      .map((r) => ({
        address: r.address,
        verified: r.verified === 1,
        createdAt: Number(r.created_at),
      }));
  }

  verifyForwardingDestination(address: string, token: string): boolean {
    const a = normalizeAddress(address);

    const row = this.sql.one<{ token: string }>(
      "SELECT token FROM forwarding_destinations WHERE address = ?",
      a,
    );

    if (!row || !timingSafeEqual(row.token, token.trim())) return false;
    this.sql.run("UPDATE forwarding_destinations SET verified = 1 WHERE address = ?", a);

    return true;
  }

  putForwardingRule(rule: {
    readonly ruleId?: string;
    readonly matchSender?: string;
    readonly destination: string;
    readonly keepCopy: boolean;
  }): string {
    const dest = normalizeAddress(rule.destination);

    if (
      !this.sql.one(
        "SELECT 1 AS x FROM forwarding_destinations WHERE address = ? AND verified = 1",
        dest,
      )
    )
      reject("forbidden", "forwarding destination not verified");
    const id = rule.ruleId ?? this.ctx.id("fwd");
    this.sql.run(
      `INSERT INTO forwarding_rules (rule_id, match_sender, destination, keep_copy) VALUES (?, ?, ?, ?)
       ON CONFLICT (rule_id) DO UPDATE SET match_sender = excluded.match_sender, destination = excluded.destination, keep_copy = excluded.keep_copy`,
      id,
      rule.matchSender ? normalizeAddress(rule.matchSender) : null,
      dest,
      rule.keepCopy,
    );

    return id;
  }

  deleteForwardingRule(ruleId: string): void {
    this.sql.run("DELETE FROM forwarding_rules WHERE rule_id = ?", ruleId);
  }

  maybeForward(input: {
    readonly from: string;
    readonly recipient: string;
    readonly messageKey: string;
    readonly threadId: string;
    readonly hops: number;
    readonly bytes: number;
  }): MaybeForwardResult {
    if (input.hops >= MAX_FORWARD_HOPS) return { jobIds: [], discardLocal: false };

    const rules = this.sql.all<{ destination: string; keep_copy: number }>(
      `SELECT r.destination, r.keep_copy FROM forwarding_rules r JOIN forwarding_destinations d ON d.address = r.destination AND d.verified = 1
       WHERE r.match_sender IS NULL OR r.match_sender = ? OR r.match_sender = ?`,
      input.from,
      domainOf(input.from),
    );

    const jobIds: Array<string> = [];
    let discardLocal = false;

    for (const r of rules) {
      // Loop protection: never forward back to the original sender or to ourselves.
      if (r.destination === input.from || r.destination === normalizeAddress(input.recipient))
        continue;
      jobIds.push(
        this.sends.createForwardJob({
          destination: r.destination,
          recipient: input.recipient,
          messageKey: input.messageKey,
          threadId: input.threadId,
          bytes: input.bytes,
        }),
      );

      if (r.keep_copy === 0) discardLocal = true;
    }

    return { jobIds, discardLocal };
  }
}
