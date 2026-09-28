import { calNormAddress } from "./address.ts";
import { calParseRRule, CalRRuleError, calSerializeRRule } from "./rrule.ts";
import type { CalEventData, CalSeries } from "./series.ts";
import { type CalDuration, calEndFor, type CalTime } from "./time.ts";
import { calAddDays, calIsValidTimeZone, calWallClock, calZonedToInstant } from "./tz.ts";

// Tolerant iCalendar (RFC 5545) reader and conservative writer (§9, C05, A04).

export interface CalIcsProperty {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
}

export interface CalIcsComponent {
  readonly name: string;
  readonly properties: Array<CalIcsProperty>;
  readonly components: Array<CalIcsComponent>;
}

export class CalIcsError extends Error {
  readonly _tag = "CalIcsError";
}

const unfold = (text: string): Array<string> =>
  text
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((l) => l.trim().length > 0);

const parseLine = (line: string): CalIcsProperty | undefined => {
  let i = 0;
  let inQuote = false;
  let nameEnd = -1;

  for (; i < line.length; i++) {
    const c = line[i];

    if (c === '"') inQuote = !inQuote;
    else if (!inQuote && (c === ";" || c === ":") && nameEnd < 0) nameEnd = i;

    if (!inQuote && c === ":") break;
  }

  if (i >= line.length || nameEnd < 0) return undefined;
  const name = line.slice(0, nameEnd).toUpperCase();
  const paramText = line.slice(nameEnd, i);
  const params: Record<string, string> = {};
  const re = /;([A-Za-z0-9-]+)=("[^"]*"|[^;:]*)/g;

  for (let m = re.exec(paramText); m; m = re.exec(paramText)) {
    params[m[1]!.toUpperCase()] = m[2]!.replace(/^"|"$/g, "");
  }

  return { name, params, value: line.slice(i + 1) };
};

/** Parse raw iCalendar text into a component tree. Unbalanced components are closed leniently. */
export const calParseIcsTree = (text: string, maxLines = 200_000): CalIcsComponent => {
  const root: CalIcsComponent = { name: "ROOT", properties: [], components: [] };
  const stack: Array<CalIcsComponent> = [root];
  const lines = unfold(text);

  if (lines.length > maxLines) throw new CalIcsError("calendar exceeds line limit");

  for (const line of lines) {
    const prop = parseLine(line);

    if (!prop) continue;

    if (prop.name === "BEGIN") {
      const c: CalIcsComponent = {
        name: prop.value.trim().toUpperCase(),
        properties: [],
        components: [],
      };

      stack.at(-1)!.components.push(c);
      stack.push(c);
    } else if (prop.name === "END") {
      const name = prop.value.trim().toUpperCase();
      const idx = stack.map((c) => c.name).lastIndexOf(name);

      if (idx > 0) stack.length = idx;
    } else {
      stack.at(-1)!.properties.push(prop);
    }
  }

  return root;
};

export const calUnescapeText = (value: string): string =>
  value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

export const calEscapeText = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

/**
 * Control characters other than HTAB (RFC 5545 §3.1 forbids them in content lines). CR/LF in a
 * raw value would end the content line and let the value inject properties or components.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F]/g;

/** Strip control characters from a raw (unescaped) property or parameter value. */
export const calStripControl = (value: string): string => value.replace(CONTROL, "");

const encoder = new TextEncoder();

/** Fold at 75 octets without splitting a UTF-8 sequence. */
export const calFoldLine = (line: string): string => {
  if (encoder.encode(line).length <= 75) return line;
  const out: Array<string> = [];
  let current = "";
  let bytes = 0;
  const limit = (): number => (out.length === 0 ? 75 : 74);

  for (const ch of line) {
    const size = encoder.encode(ch).length;

    if (bytes + size > limit()) {
      out.push(current);
      current = "";
      bytes = 0;
    }

    current += ch;
    bytes += size;
  }

  out.push(current);

  return out.join("\r\n ");
};

/** A parameter value: no control characters or DQUOTE (RFC 5545 has no escape for them). */
const quoteParam = (raw: string): string => {
  const v = calStripControl(raw).replace(/"/g, "");

  return /[:;,]/.test(v) ? `"${v}"` : v;
};

interface IcsParamMap {
  [name: string]: string;
}

interface IcsZoneNameMap {
  readonly [name: string]: string;
}

interface IcsTimeValue {
  readonly params: IcsParamMap;
  readonly value: string;
}

/** Serialize one content line. Every value is stripped of control characters before folding. */
const attendeeParams = (a: {
  readonly name?: string | undefined;
  readonly partstat: string;
  readonly role?: string | undefined;
  readonly rsvp?: boolean | undefined;
}): IcsParamMap => {
  const params: IcsParamMap = {};

  if (a.name) params["CN"] = a.name;
  params["PARTSTAT"] = a.partstat;

  if (a.role) params["ROLE"] = a.role;

  if (a.rsvp) params["RSVP"] = "TRUE";

  return params;
};

export const calSerializeProperty = (p: CalIcsProperty): string =>
  calFoldLine(
    `${p.name}${Object.entries(p.params)
      .map(([k, v]) => `;${k}=${quoteParam(v)}`)
      .join("")}:${calStripControl(p.value)}`,
  );

export const calSerializeComponent = (c: CalIcsComponent): string =>
  [
    `BEGIN:${c.name}`,
    ...c.properties.map(calSerializeProperty),
    ...c.components.map(calSerializeComponent),
    `END:${c.name}`,
  ].join("\r\n");

// ---- durations ----

/**
 * A DURATION split into its nominal part (weeks and days, which follow the wall clock across DST)
 * and its exact part (hours, minutes, seconds) — RFC 5545 §3.3.6.
 */
export interface CalIcsDuration {
  readonly days: number;
  readonly ms: number;
}

export const calParseDurationParts = (value: string): CalIcsDuration => {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );

  if (!m) throw new CalIcsError(`invalid duration ${value}`);
  const [, sign, w, d, h, mi, s] = m;
  const days = Number(w ?? 0) * 7 + Number(d ?? 0);
  const ms = (Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0)) * 1000;
  const k = sign === "-" ? -1 : 1;

  return { days: k * days || 0, ms: k * ms || 0 };
};

/** A DURATION as exact milliseconds (a day counts as 24h; use for alarm triggers, not DTEND). */
export const calParseDuration = (value: string): number => {
  const { days, ms } = calParseDurationParts(value);

  return days * 86_400_000 + ms;
};

/**
 * DTEND from DTSTART + DURATION: days are nominal (same wall-clock time N days later in the start's
 * zone, so P1D across a DST change is 23h or 25h), then the exact part is added (RFC 5545 §3.3.6).
 */
export const calEndForIcsDuration = (start: CalTime, duration: CalIcsDuration): CalTime => {
  if (start.kind === "date")
    return calEndFor(start, {
      kind: "days",
      days: duration.days + Math.round(duration.ms / 86_400_000),
    });
  const local = { ...start.local, ...calAddDays(start.local, duration.days) };
  const instant = calZonedToInstant(local, start.tzid) + duration.ms;

  return { kind: "timed", tzid: start.tzid, local: calWallClock(instant, start.tzid) };
};

export const calFormatDuration = (ms: number): string => {
  const sign = ms < 0 ? "-" : "";
  let rest = Math.abs(Math.round(ms / 1000));
  const days = Math.floor(rest / 86400);
  rest -= days * 86400;
  const h = Math.floor(rest / 3600);
  rest -= h * 3600;
  const m = Math.floor(rest / 60);
  const s = rest - m * 60;
  const time = `${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s ? `${s}S` : ""}`;

  if (!time) return `${sign}P${days}D`;

  return `${sign}P${days ? `${days}D` : ""}T${time}`;
};

// ---- time zones ----

const WINDOWS_ZONES: IcsZoneNameMap = {
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "Lord Howe Standard Time": "Australia/Lord_Howe",
  "Tokyo Standard Time": "Asia/Tokyo",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  UTC: "UTC",
  "Coordinated Universal Time": "UTC",
};

/** Resolve a (possibly vendor-prefixed or Windows) TZID to an IANA zone. */
export const calResolveTzid = (tzid: string): string | undefined => {
  const trimmed = tzid.trim().replace(/^"|"$/g, "");

  if (WINDOWS_ZONES[trimmed]) return WINDOWS_ZONES[trimmed];

  if (calIsValidTimeZone(trimmed) && /\/|^UTC$|^GMT$/.test(trimmed)) return trimmed;
  const segments = trimmed.split("/").filter(Boolean);

  for (let i = 0; i < segments.length - 1; i++) {
    const candidate = segments.slice(i).join("/");

    if (calIsValidTimeZone(candidate)) return candidate;
  }

  return undefined;
};

export interface CalParseContext {
  readonly defaultZone: string;
  readonly warnings: Array<string>;
}

export const calParseTimeValue = (
  value: string,
  params: Readonly<Record<string, string>>,
  ctx: CalParseContext,
): CalTime => {
  const v = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(v);

  if (!m) throw new CalIcsError(`invalid date-time ${value}`);
  const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };

  if (params.VALUE === "DATE" || m[4] === undefined) return { kind: "date", date };

  const local = {
    ...date,
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Math.min(59, Number(m[6])),
  };

  if (m[7] === "Z") return { kind: "timed", local, tzid: "UTC" };

  if (params.TZID) {
    const zone = calResolveTzid(params.TZID);

    if (zone) return { kind: "timed", local, tzid: zone };
    ctx.warnings.push(`unknown TZID ${params.TZID}; using ${ctx.defaultZone}`);
  }

  return { kind: "timed", local, tzid: ctx.defaultZone };
};

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

export const calFormatTimeValue = (t: CalTime): IcsTimeValue => {
  if (t.kind === "date")
    return {
      params: { VALUE: "DATE" },
      value: `${pad(t.date.year, 4)}${pad(t.date.month)}${pad(t.date.day)}`,
    };
  const l = t.local;
  const value = `${pad(l.year, 4)}${pad(l.month)}${pad(l.day)}T${pad(l.hour)}${pad(l.minute)}${pad(l.second)}`;

  return t.tzid === "UTC"
    ? { params: {}, value: `${value}Z` }
    : { params: { TZID: t.tzid }, value };
};

export const calFormatUtcStamp = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

const parseUtcStamp = (value: string): number | undefined => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim());

  return m
    ? Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
      )
    : undefined;
};

// ---- events ----

export type CalPartstat = "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE" | "DECLINED" | "DELEGATED";

export interface CalPerson {
  readonly address: string;
  readonly name?: string | undefined;
}

export interface CalAttendee extends CalPerson {
  readonly partstat: CalPartstat;
  readonly role?: string | undefined;
  readonly rsvp?: boolean | undefined;
}

export interface CalIcsEvent {
  readonly uid: string;
  readonly sequence: number;
  readonly dtstamp: number | undefined;
  /** Set for an occurrence override or a per-occurrence iTIP message. */
  readonly recurrenceId?: CalTime | undefined;
  readonly thisAndFuture?: boolean | undefined;
  readonly series: CalSeries;
  readonly organizer?: CalPerson | undefined;
  readonly attendees: ReadonlyArray<CalAttendee>;
  /** Reminder offsets in minutes before start (positive = before). */
  readonly alarms: ReadonlyArray<number>;
}

export interface CalIcsCalendar {
  readonly method: string | undefined;
  readonly prodId: string | undefined;
  readonly events: ReadonlyArray<CalIcsEvent>;
  readonly warnings: ReadonlyArray<string>;
  readonly truncated: boolean;
}

const first = (c: CalIcsComponent, name: string): CalIcsProperty | undefined =>
  c.properties.find((p) => p.name === name);

const all = (c: CalIcsComponent, name: string): Array<CalIcsProperty> =>
  c.properties.filter((p) => p.name === name);

const PARTSTATS: ReadonlyArray<CalPartstat> = [
  "NEEDS-ACTION",
  "ACCEPTED",
  "TENTATIVE",
  "DECLINED",
  "DELEGATED",
];

const parseEvent = (c: CalIcsComponent, ctx: CalParseContext): CalIcsEvent | undefined => {
  const uid = first(c, "UID")?.value.trim();
  const dtstartProp = first(c, "DTSTART");

  if (!uid || !dtstartProp) {
    ctx.warnings.push("VEVENT without UID or DTSTART skipped");

    return undefined;
  }

  const dtstart = calParseTimeValue(dtstartProp.value, dtstartProp.params, ctx);
  const dtendProp = first(c, "DTEND");
  const durationProp = first(c, "DURATION");
  let dtend: CalTime;
  let nominal: CalDuration | undefined;

  if (dtendProp) {
    dtend = calParseTimeValue(dtendProp.value, dtendProp.params, ctx);
  } else if (durationProp) {
    const parts = calParseDurationParts(durationProp.value);
    dtend = calEndForIcsDuration(dtstart, parts);

    if (parts.days > 0) nominal = { kind: "nominal", days: parts.days, ms: parts.ms };
  } else {
    dtend = dtstart.kind === "date" ? { kind: "date", date: calAddDays(dtstart.date, 1) } : dtstart;
  }

  let rule;
  const rruleProp = first(c, "RRULE");

  if (rruleProp) {
    try {
      rule = calParseRRule(rruleProp.value);
    } catch (error) {
      if (!(error instanceof CalRRuleError)) throw error;
      ctx.warnings.push(`${uid}: ${error.message}; imported as single occurrence`);
    }
  }

  const multi = (name: string): Array<CalTime> =>
    all(c, name).flatMap((p) =>
      p.value
        .split(",")
        .filter(Boolean)
        .flatMap((v) => {
          try {
            return [calParseTimeValue(v, p.params, ctx)];
          } catch {
            ctx.warnings.push(`${uid}: invalid ${name} ${v}`);

            return [];
          }
        }),
    );

  const text = (name: string): string | undefined => {
    const p = first(c, name);

    return p ? calUnescapeText(p.value) : undefined;
  };

  const status = text("STATUS")?.toLowerCase();

  const data: CalEventData = {
    summary: text("SUMMARY") ?? "",
    description: text("DESCRIPTION"),
    location: text("LOCATION"),
    url: first(c, "URL")?.value,
    transparent: first(c, "TRANSP")?.value.toUpperCase() === "TRANSPARENT",
    status:
      status === "tentative" || status === "cancelled" || status === "confirmed"
        ? status
        : "confirmed",
  };

  const organizerProp = first(c, "ORGANIZER");
  const recurrenceProp = first(c, "RECURRENCE-ID");

  const alarms = c.components
    .filter((a) => a.name === "VALARM")
    .flatMap((a) => {
      const trigger = first(a, "TRIGGER");

      if (!trigger || trigger.params.VALUE === "DATE-TIME") return [];

      try {
        return [Math.round(-calParseDuration(trigger.value) / 60_000)];
      } catch {
        return [];
      }
    });

  const baseSeries: CalSeries = {
    uid,
    dtstart,
    dtend,
    rule,
    rdates: multi("RDATE"),
    exdates: multi("EXDATE"),
    data,
  };

  const series: CalSeries = nominal ? { ...baseSeries, duration: nominal } : baseSeries;

  return {
    uid,
    sequence: Number(first(c, "SEQUENCE")?.value ?? 0) || 0,
    dtstamp: first(c, "DTSTAMP") ? parseUtcStamp(first(c, "DTSTAMP")!.value) : undefined,
    recurrenceId: recurrenceProp
      ? calParseTimeValue(recurrenceProp.value, recurrenceProp.params, ctx)
      : undefined,
    thisAndFuture: recurrenceProp?.params.RANGE?.toUpperCase() === "THISANDFUTURE",
    series,
    organizer: organizerProp
      ? { address: calNormAddress(organizerProp.value), name: organizerProp.params.CN }
      : undefined,
    attendees: all(c, "ATTENDEE").map((p) => {
      const ps = (p.params.PARTSTAT ?? "NEEDS-ACTION").toUpperCase() as CalPartstat;

      return {
        address: calNormAddress(p.value),
        name: p.params.CN,
        partstat: PARTSTATS.includes(ps) ? ps : "NEEDS-ACTION",
        role: p.params.ROLE,
        rsvp: p.params.RSVP?.toUpperCase() === "TRUE",
      };
    }),
    alarms: [...new Set(alarms)],
  };
};

export interface CalParseOptions {
  readonly defaultZone?: string;
  readonly maxItems?: number;
}

/** Parse a calendar document. Bounded by `maxItems` (external feeds, §9). */
export const calParseCalendar = (text: string, options: CalParseOptions = {}): CalIcsCalendar => {
  const tree = calParseIcsTree(text);
  const vcal = tree.components.find((c) => c.name === "VCALENDAR") ?? tree;
  const ctx: CalParseContext = { defaultZone: options.defaultZone ?? "UTC", warnings: [] };
  const maxItems = options.maxItems ?? 10_000;
  const vevents = vcal.components.filter((c) => c.name === "VEVENT");
  const events: Array<CalIcsEvent> = [];

  for (const v of vevents.slice(0, maxItems)) {
    try {
      const e = parseEvent(v, ctx);

      if (e) events.push(e);
    } catch (error) {
      ctx.warnings.push(error instanceof Error ? error.message : "invalid VEVENT");
    }
  }

  return {
    method: first(vcal, "METHOD")?.value.trim().toUpperCase(),
    prodId: first(vcal, "PRODID")?.value,
    events,
    warnings: ctx.warnings,
    truncated: vevents.length > maxItems,
  };
};

const timeProp = (name: string, t: CalTime, extra: Record<string, string> = {}): CalIcsProperty => {
  const f = calFormatTimeValue(t);

  return { name, params: { ...f.params, ...extra }, value: f.value };
};

export interface CalSerializeEventOptions {
  /** Private fields are never serialized; this flag exists so callers state intent explicitly. */
  readonly includeDescription?: boolean;
}

export const calEventComponent = (
  e: CalIcsEvent,
  now: number,
  options: CalSerializeEventOptions = {},
): CalIcsComponent => {
  const p: Array<CalIcsProperty> = [
    { name: "UID", params: {}, value: e.uid },
    { name: "DTSTAMP", params: {}, value: calFormatUtcStamp(e.dtstamp ?? now) },
    { name: "SEQUENCE", params: {}, value: String(e.sequence) },
  ];

  if (e.recurrenceId)
    p.push(
      timeProp("RECURRENCE-ID", e.recurrenceId, e.thisAndFuture ? { RANGE: "THISANDFUTURE" } : {}),
    );
  p.push(timeProp("DTSTART", e.series.dtstart), timeProp("DTEND", e.series.dtend));

  if (e.series.rule && !e.recurrenceId)
    p.push({ name: "RRULE", params: {}, value: calSerializeRRule(e.series.rule) });

  for (const r of e.series.rdates ?? []) p.push(timeProp("RDATE", r));

  for (const x of e.series.exdates ?? []) p.push(timeProp("EXDATE", x));
  const d = e.series.data;
  p.push({ name: "SUMMARY", params: {}, value: calEscapeText(d.summary) });

  if (d.description && options.includeDescription !== false)
    p.push({ name: "DESCRIPTION", params: {}, value: calEscapeText(d.description) });

  if (d.location) p.push({ name: "LOCATION", params: {}, value: calEscapeText(d.location) });

  if (d.url) p.push({ name: "URL", params: {}, value: d.url });

  if (d.status) p.push({ name: "STATUS", params: {}, value: d.status.toUpperCase() });
  p.push({ name: "TRANSP", params: {}, value: d.transparent ? "TRANSPARENT" : "OPAQUE" });

  if (e.organizer)
    p.push({
      name: "ORGANIZER",
      params: e.organizer.name ? { CN: e.organizer.name } : {},
      value: `mailto:${e.organizer.address}`,
    });

  for (const a of e.attendees) {
    p.push({
      name: "ATTENDEE",
      params: attendeeParams(a),
      value: `mailto:${a.address}`,
    });
  }

  return {
    name: "VEVENT",
    properties: p,
    components: e.alarms.map((minutes) => ({
      name: "VALARM",
      properties: [
        { name: "ACTION", params: {}, value: "DISPLAY" },
        { name: "DESCRIPTION", params: {}, value: calEscapeText(d.summary || "Reminder") },
        { name: "TRIGGER", params: {}, value: calFormatDuration(-minutes * 60_000) },
      ],
      components: [],
    })),
  };
};

export interface CalSerializeOptions extends CalSerializeEventOptions {
  readonly method?: string;
  readonly name?: string;
  readonly now: number;
}

export const calSerializeCalendar = (
  events: ReadonlyArray<CalIcsEvent>,
  options: CalSerializeOptions,
): string =>
  calSerializeComponent({
    name: "VCALENDAR",
    properties: [
      { name: "VERSION", params: {}, value: "2.0" },
      { name: "PRODID", params: {}, value: "-//bye//calendar 1.0//EN" },
      { name: "CALSCALE", params: {}, value: "GREGORIAN" },
      ...(options.method ? [{ name: "METHOD", params: {}, value: options.method }] : []),
      ...(options.name
        ? [{ name: "X-WR-CALNAME", params: {}, value: calEscapeText(options.name) }]
        : []),
    ],
    components: events.map((e) => calEventComponent(e, options.now, options)),
  }) + "\r\n";
