import type React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { ByeIcon, ByeLogo, Wordmark, colors } from "./brand";
import { LineByLineSlide } from "./components/remocn/line-by-line-slide";
import { ProgressSteps } from "./components/remocn/progress-steps";
import { SimulatedCursor } from "./components/remocn/simulated-cursor";

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const fadeUp = (frame: number, fps: number, start: number, distance = 18): React.CSSProperties => {
  const progress = spring({
    fps,
    frame: frame - start,
    config: { damping: 18, stiffness: 120, mass: 0.7 },
  });
  return {
    opacity: interpolate(progress, [0, 1], [0, 1]),
    transform: `translateY(${interpolate(progress, [0, 1], [distance, 0])}px)`,
  };
};

const SceneHeader = ({ label }: { label: string }) => (
  <div className="scene-header">
    <ByeLogo className="brand" iconSize={34} />
    <span className="status-note">{label}</span>
  </div>
);

const Title = ({
  eyebrow,
  title,
  copy,
  size = 46,
}: {
  eyebrow: string;
  title: string;
  copy?: string;
  size?: number;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ ...fadeUp(frame, fps, 3), position: "absolute", top: 112, left: 64 }}>
      <div className="eyebrow">{eyebrow}</div>
      <h2 className="section-title" style={{ marginTop: 8, fontSize: size }}>
        {title}
      </h2>
      {copy ? <p className="section-copy">{copy}</p> : null}
    </div>
  );
};

const Footnote = ({ children, start }: { children: React.ReactNode; start: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      className="status-note"
      style={{ ...fadeUp(frame, fps, start, 8), position: "absolute", left: 64, bottom: 34 }}
    >
      {children}
    </div>
  );
};

export const HeroScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ruleWidth = interpolate(frame, [45, 78], [0, 148], clamp);

  return (
    <div className="scene">
      <SceneHeader label="Open-source email + calendar · inspired by HEY" />
      <div className="hero-copy">
        <LineByLineSlide
          text={"Say bye to what matters,\nand hey to the rest."}
          renderLine={(line) => {
            const [before, after] = line.split("bye");
            return after === undefined ? (
              line
            ) : (
              <>
                {before}
                <em style={{ color: colors.sunset }}>bye</em>
                {after}
              </>
            );
          }}
          className="headline"
          fontSize={76}
          fontWeight={800}
          color="var(--ink)"
          distance={56}
        />
      </div>
      <div className="hero-rule" style={{ width: ruleWidth }} />
      <div
        style={{
          ...fadeUp(frame, fps, 58),
          position: "absolute",
          left: 140,
          top: 500,
          maxWidth: 820,
          color: "var(--muted)",
          fontSize: 20,
          lineHeight: 1.5,
        }}
      >
        Email and calendar on Cloudflare primitives, built in TypeScript with Effect v4 and Alchemy.
      </div>
      <Footnote start={78}>
        Validated locally in Node and workerd · not deployed to Cloudflare or production.
      </Footnote>
    </div>
  );
};

const Row = ({
  from,
  subject,
  tag,
  unseen,
  style,
}: {
  from: string;
  subject: string;
  tag?: React.ReactNode;
  unseen?: boolean;
  style?: React.CSSProperties;
}) => (
  <div className="mail-row" data-unseen={unseen ? "true" : "false"} style={style}>
    <span className="mail-from">{from}</span>
    <span className="mail-subject">{subject}</span>
    {tag}
  </div>
);

export const ScreenerScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const approved = frame >= 96;
  const arrive = spring({
    fps,
    frame: frame - 100,
    config: { damping: 16, stiffness: 130, mass: 0.7 },
  });

  return (
    <div className="scene">
      <SceneHeader label="Screener · E01" />
      <Title
        eyebrow="You decide who gets in"
        title="Unknown senders wait outside."
        copy="Approve or reject each one. Reading a message never approves its sender."
      />
      <div className="mail-window" style={{ left: 64, top: 340, width: 560, height: 260 }}>
        <div className="window-bar">
          <span className="window-dot" />
          <span className="window-dot" />
          <span className="window-dot" />
          <span className="mono" style={{ marginLeft: 8, color: "var(--muted)", fontSize: 10 }}>
            Screener · 2 waiting
          </span>
        </div>
        <Row
          from="hello@atlas-travel.example"
          subject="Your itinerary for June"
          tag={
            <span className={approved ? "button button-quiet" : "button button-primary"}>
              {approved ? "Approved" : "Approve"}
            </span>
          }
          style={approved ? { opacity: 0.45 } : undefined}
        />
        <Row
          from="deals@promo.example"
          subject="You have been selected!!!"
          tag={<span className="button button-quiet">Reject</span>}
        />
      </div>
      <div className="mail-window" style={{ left: 680, top: 340, width: 536, height: 260 }}>
        <div className="window-bar">
          <span className="window-dot" />
          <span className="window-dot" />
          <span className="window-dot" />
          <span className="mono" style={{ marginLeft: 8, color: "var(--muted)", fontSize: 10 }}>
            Imbox · New for you
          </span>
        </div>
        <Row from="Maya Chen" subject="Notes from Thursday" />
        {approved ? (
          <Row
            from="hello@atlas-travel.example"
            subject="Your itinerary for June"
            unseen
            style={{
              opacity: arrive,
              transform: `translateY(${interpolate(arrive, [0, 1], [-16, 0])}px)`,
            }}
          />
        ) : null}
      </div>
      <Footnote start={150}>
        Clearing the pending list never silently approves its senders.
      </Footnote>
      <SimulatedCursor
        points={[
          { x: 300, y: 300, hold: 10 },
          { x: 566, y: 436, hold: 40, click: true },
          { x: 760, y: 520, hold: 30 },
        ]}
        color={colors.ink}
        size={28}
      />
    </div>
  );
};

const piles = [
  {
    title: "Imbox",
    note: "New for you",
    left: 64,
    rows: [
      ["Maya Chen", "Notes from Thursday", true],
      ["Ravi Patel", "Re: contract draft", true],
      ["Ana Souza", "Lunch?", false],
    ],
  },
  {
    title: "The Feed",
    note: "Newsletters, expanded",
    left: 452,
    rows: [
      ["Weekly Systems", "Issue 214 · Queues, revisited", false],
      ["The Long Read", "How ports got automated", false],
      ["Field Notes", "Edition 88", false],
    ],
  },
  {
    title: "The Paper Trail",
    note: "Receipts + transactions",
    left: 840,
    rows: [
      ["Corner Grocer", "Receipt #40213", false],
      ["Metro Transit", "Your monthly pass", false],
      ["Atlas Travel", "Booking confirmation", false],
    ],
  },
] as const;

export const PilesScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <div className="scene">
      <SceneHeader label="Attention piles · E04–E09" />
      <Title
        eyebrow="Everything in its place"
        title="Three piles. No inbox zero guilt."
        size={44}
      />
      {piles.map((pile, index) => {
        const progress = spring({
          fps,
          frame: frame - 18 - index * 10,
          config: { damping: 17, stiffness: 120, mass: 0.75 },
        });
        return (
          <div
            className="pile"
            key={pile.title}
            style={{
              left: pile.left,
              top: 236,
              width: 376,
              height: 236,
              opacity: progress,
              transform: `translateY(${interpolate(progress, [0, 1], [26, 0])}px)`,
            }}
          >
            <div className="pile-title">
              <span>{pile.title}</span>
              <span
                className="mono"
                style={{ color: "var(--muted)", fontSize: 10, fontWeight: 500 }}
              >
                {pile.note}
              </span>
            </div>
            {pile.rows.map(([from, subject, unseen]) => (
              <div
                className="mail-row"
                data-unseen={unseen ? "true" : "false"}
                key={subject}
                style={{ gridTemplateColumns: "120px 1fr", minHeight: 50, fontSize: 12 }}
              >
                <span className="mail-from">{from}</span>
                <span className="mail-subject">{subject}</span>
              </div>
            ))}
          </div>
        );
      })}
      <div style={{ position: "absolute", left: 64, top: 510, display: "flex", gap: 12 }}>
        {[
          ["Reply Later", "a queue that survives restarts"],
          ["Set Aside", "a reference pile, not the archive"],
          ["Bubble Up", "return a thread when you need it"],
        ].map(([name, copy], index) => (
          <div
            className="node"
            key={name}
            style={{ position: "relative", width: 376, ...fadeUp(frame, fps, 70 + index * 12, 14) }}
          >
            <div className="node-title">{name}</div>
            <div className="node-copy">{copy}</div>
          </div>
        ))}
      </div>
      <Footnote start={130}>
        A new reply pulls a bubbled thread back to New for you as one row, never a copy.
      </Footnote>
    </div>
  );
};

export const OutboundScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <div className="scene">
      <SceneHeader label="Outbound · persisted send jobs" />
      <Title
        eyebrow="Send with a safety net"
        title="One frozen draft. One durable send."
        copy="Each step is a persisted job. A timeout after submission becomes unknown, never a blind retry."
        size={42}
      />
      <div className="release-shell panel">
        <ProgressSteps
          steps={[
            { label: "Freeze draft" },
            { label: "Undo window" },
            { label: "Render MIME" },
            { label: "Submit" },
            { label: "Record" },
          ]}
          activeColor={colors.sunset}
          inactiveColor="#e4dccb"
          textColor={colors.ink}
          stepDuration={27}
        />
        <div
          style={{
            ...fadeUp(frame, fps, 120, 8),
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 30,
            display: "flex",
            justifyContent: "center",
            gap: 12,
          }}
        >
          <span className="chip">Bcc stays envelope-only</span>
          <span className="chip">send-as authority re-checked</span>
          <span className="chip">
            <span className="chip-dot" />
            accepted · not accepted · unknown
          </span>
        </div>
      </div>
    </div>
  );
};

const events = [
  { day: 0, top: 20, height: 74, title: "Design review", time: "09:30" },
  { day: 1, top: 96, height: 60, title: "1:1 · Maya", time: "11:00" },
  { day: 2, top: 20, height: 100, title: "Planning", time: "09:00", invite: true },
  { day: 3, top: 130, height: 60, title: "Focus block", time: "14:00" },
  { day: 4, top: 50, height: 66, title: "Ship review", time: "10:00" },
];

export const CalendarScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const invite = spring({
    fps,
    frame: frame - 70,
    config: { damping: 15, stiffness: 130, mass: 0.7 },
  });

  return (
    <div className="scene">
      <SceneHeader label="Calendar · time zones, RRULE, iTIP" />
      <Title
        eyebrow="Mail and calendar, one account"
        title="Invitations become events."
        copy="Invites from approved senders arrive on your calendar. Replies leave as iTIP through your mailbox."
        size={42}
      />
      <div className="mail-window" style={{ left: 64, top: 350, width: 1152, height: 290 }}>
        <div className="cal-grid">
          <div>
            <div className="cal-head" />
          </div>
          {["Mon", "Tue", "Wed", "Thu", "Fri"].map((day, index) => (
            <div className="cal-col" key={day}>
              <div className="cal-head">{day}</div>
              {events
                .filter((event) => event.day === index)
                .map((event) => {
                  const isInvite = "invite" in event;
                  const progress = isInvite
                    ? invite
                    : spring({
                        fps,
                        frame: frame - 24 - index * 6,
                        config: { damping: 16, stiffness: 130, mass: 0.7 },
                      });
                  return (
                    <div
                      className="cal-event"
                      key={event.title}
                      style={{
                        top: 46 + event.top,
                        height: event.height,
                        opacity: progress,
                        transform: `scale(${interpolate(progress, [0, 1], [0.92, 1])})`,
                        ...(isInvite
                          ? { background: "var(--unseen)", borderLeftColor: colors.sunset }
                          : null),
                      }}
                    >
                      {event.title}
                      <div className="mono" style={{ color: "var(--muted)", fontWeight: 500 }}>
                        {event.time}
                        {isInvite ? " · invite" : ""}
                      </div>
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
      <Footnote start={110}>
        Events, tasks, reminders and time tracking share the same account.
      </Footnote>
    </div>
  );
};

const platforms = ["PWA", "CLI / TUI", "iOS", "Android", "macOS", "Windows"];

export const ClientsScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lines = [
    { at: 20, text: "$ pnpm exec bye instance add https://mail.example.com", dim: false },
    { at: 62, text: "✓ /.well-known/bye-instance validated", dim: true },
    { at: 84, text: "✓ RFC 8414 issuer metadata validated", dim: true },
    { at: 106, text: "✓ saved · sign in with PKCE", dim: true },
  ];

  return (
    <div className="scene">
      <SceneHeader label="Clients · hosted or self-hosted" />
      <Title
        eyebrow="Bring your own server"
        title="One app. Any compatible instance."
        copy="Clients validate an instance without credentials before saving it."
        size={42}
      />
      <div
        className="terminal"
        style={{ left: 64, top: 350, width: 700, height: 210, padding: 24 }}
      >
        {lines.map((line) => (
          <div
            key={line.text}
            style={{
              opacity: interpolate(frame, [line.at, line.at + 8], [0, 1], clamp),
              color: line.dim ? "#a8a08d" : "#f6f1e7",
            }}
          >
            {line.text}
          </div>
        ))}
      </div>
      <div
        style={{ position: "absolute", left: 820, top: 350, width: 396, display: "grid", gap: 10 }}
      >
        {platforms.map((name, index) => (
          <div
            className="node"
            key={name}
            style={{
              position: "relative",
              width: "100%",
              minHeight: 0,
              padding: "9px 16px",
              display: "flex",
              justifyContent: "space-between",
              ...fadeUp(frame, fps, 30 + index * 8, 10),
            }}
          >
            <span className="node-title" style={{ fontSize: 13 }}>
              {name}
            </span>
            <span className="mono" style={{ color: "var(--muted)", fontSize: 10 }}>
              {name === "Windows" || name === "Android" ? "built in CI" : "verified locally"}
            </span>
          </div>
        ))}
      </div>
      <Footnote start={120}>
        Linux uses the PWA. Device, signing and upgrade tests remain open.
      </Footnote>
    </div>
  );
};

export const OutroScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const mark = spring({ fps, frame, config: { damping: 17, stiffness: 110, mass: 0.8 } });

  return (
    <div className="scene" style={{ display: "grid", placeItems: "center", textAlign: "center" }}>
      <div>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 20,
            transform: `scale(${interpolate(mark, [0, 1], [0.72, 1])})`,
            opacity: mark,
          }}
        >
          <ByeIcon size={84} />
          <Wordmark size={92} />
        </div>
        <h2
          className="headline"
          style={{
            ...fadeUp(frame, fps, 18, 20),
            maxWidth: 900,
            margin: "30px auto 0",
            fontSize: 52,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.08,
          }}
        >
          Email with boundaries.
          <br />
          Open source, yours to run.
        </h2>
        <p
          style={{
            ...fadeUp(frame, fps, 40, 12),
            margin: "22px auto 0",
            color: "var(--muted)",
            fontSize: 18,
          }}
        >
          github.com/chr33s/bye
        </p>
      </div>
    </div>
  );
};
