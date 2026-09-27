// The onboarding page: a document plus its same-origin stylesheet and script (served by server.ts
// at /app.css and /app.js), so the CSP needs no 'unsafe-inline'. All server data is rendered with
// textContent; the only markup inserted is the server-generated QR SVG, as an image.
//
// Normal path (infra/onboarding/spec.md §2): Continue with Cloudflare → (account, if several) → Bye
// address → Create Bye → progress → first owner. Plan review, recovery kit, disconnect and the
// manual guide stay available but off the main path; review appears only when a plan needs it.

export const ONBOARDING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up Bye</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main>
  <p id="error" class="bad" role="alert"></p>

  <section id="s-connect" aria-labelledby="h-connect" hidden>
    <h1 id="h-connect">Set up Bye</h1>
    <p>Bye runs in your Cloudflare account.</p>
    <p id="auth-note" class="warn"></p>
    <button id="connect">Continue with Cloudflare</button>
    <details><summary>What Bye creates</summary><ul id="creates" class="muted"></ul>
      <p class="muted">Access requested: Workers, KV, D1, R2, Queues, Containers and Secrets Store, read access to your accounts and zones, and Workers Routes to attach one custom hostname. No DNS, MX or Email Routing access.</p>
    </details>
  </section>

  <section id="s-account" aria-labelledby="h-account" hidden>
    <h1 id="h-account">Choose a Cloudflare account</h1>
    <div class="row">
      <label>Account <select id="account"></select></label>
      <button id="account-btn">Continue</button>
    </div>
  </section>

  <section id="s-domain" aria-labelledby="h-domain" hidden>
    <h1 id="h-domain">Where should Bye live?</h1>
    <div id="zones-box">
      <p><label>Domain<br><select id="zone"></select></label></p>
      <p><label for="label">Bye address</label><br>
        <span class="row"><input id="label" type="text" value="bye" size="16" autocomplete="off" spellcheck="false" aria-describedby="label-help"> <span>.</span> <span id="zone-name"></span></span></p>
      <p id="label-help" class="muted">Lowercase letters, digits and hyphens.</p>
      <p>Your Bye:<br><strong id="preview"></strong></p>
      <button id="create-btn">Create Bye</button>
    </div>
    <div id="no-zones" hidden>
      <p>This Cloudflare account has no active domains yet.</p>
      <div class="row">
        <a href="https://dash.cloudflare.com/?to=/:account/add-site" target="_blank" rel="noopener">Add a domain in Cloudflare</a>
        <button id="refresh-zones" class="secondary">Refresh domains</button>
      </div>
    </div>
    <p class="muted">Choosing a domain does not change its mail. Incoming email is a separate step you can do later.</p>
  </section>

  <section id="s-progress" aria-labelledby="h-progress" hidden>
    <h1 id="h-progress">Creating Bye</h1>
    <ol id="steps" class="steps" aria-live="polite"></ol>
    <p id="op-error" class="bad"></p>
    <p id="op-next"></p>
    <div class="row">
      <button id="retry-btn" hidden>Try again</button>
      <button id="reconnect-btn" hidden>Reconnect Cloudflare</button>
      <button id="review-again-btn" class="secondary" hidden>Review the plan</button>
    </div>
    <details><summary>Details</summary>
      <p id="op-status" class="muted"></p>
      <table><thead><tr><th>Check</th><th>Result</th></tr></thead><tbody id="health"></tbody></table>
      <h3>Resources</h3><table><tbody id="outcomes"></tbody></table>
      <h3>Progress log</h3><ol id="progress" class="muted"></ol>
    </details>
  </section>

  <section id="s-review" aria-labelledby="h-review" hidden>
    <h1 id="h-review">Review needed</h1>
    <p>This deployment is not a standard first install, so it needs your review before anything is changed.</p>
    <ul id="review-reasons" class="warn"></ul>
    <button id="review-btn">Show the deployment plan</button>
    <div id="review" hidden>
      <table><tbody id="review-summary"></tbody></table>
      <h3>Changes</h3>
      <table><thead><tr><th>Action</th><th>Resource</th><th>Type</th></tr></thead><tbody id="changes"></tbody></table>
      <div id="blockers-box" hidden><h3 class="bad">Blocked</h3><ul id="blockers"></ul></div>
      <div id="warnings-box" hidden><h3 class="warn">Review carefully</h3><ul id="warnings"></ul></div>
      <p id="ack-row" hidden><label><input id="ack" type="checkbox"> I have reviewed the replacements and deletions above.</label></p>
      <button id="approve-btn">Approve and deploy</button>
    </div>
  </section>

  <section id="s-done" aria-labelledby="h-done" hidden>
    <h1 id="h-done">Bye is ready</h1>
    <p>Your Bye: <a id="app-link" href="#"></a></p>
    <p>Next, create your owner account with a passkey.</p>
    <button id="first-btn">Create your owner account</button>
    <details><summary>Connect the Bye apps</summary>
      <div class="row"><a id="open-link" href="#">Open in Bye</a></div>
      <div id="qr"></div>
      <p class="muted">The link and code contain only this address. The app checks the server, asks you to confirm, then you sign in there directly.</p>
    </details>
  </section>

  <section id="s-manage" aria-labelledby="h-manage" hidden>
    <details><summary id="h-manage">Recovery and connection</summary>
      <p id="bound" class="muted"></p>
      <p id="release" class="muted"></p>
      <h3>Recovery kit</h3>
      <p class="muted">Holds this instance's generated secrets so you can redeploy without this service. It contains no Cloudflare credentials and can be downloaded only once.</p>
      <button id="kit-btn" class="secondary">Download recovery kit</button>
      <p id="kit-issued" class="muted"></p>
      <h3>Cloudflare connection</h3>
      <p id="auth-status"></p>
      <button id="disconnect" class="secondary">Disconnect Cloudflare</button>
      <button id="manage-connect" class="secondary" hidden>Reconnect Cloudflare</button>
      <p id="disconnect-result" class="muted"></p>
      <h3>Manual domains and mail</h3>
      <button id="guide-btn" class="secondary">Show the guide</button>
      <div id="guide"></div>
    </details>
  </section>
</main>
<script src="/app.js"></script>
</body>
</html>
`;

export const ONBOARDING_STYLE = `:root { --bg:#fff; --fg:#1a1a1a; --muted:#5c5c5c; --line:#ddd; --accent:#1d4ed8; --bad:#b91c1c; --ok:#15803d; --warn:#a16207; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#aaa; --line:#333; --accent:#8ab4ff; --bad:#f87171; --ok:#4ade80; --warn:#facc15; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 1.6rem; margin: 0 0 8px; }
h3 { font-size: 1rem; margin: 16px 0 4px; }
section { padding: 8px 0 24px; }
#s-manage { border-top: 1px solid var(--line); padding-top: 16px; }
.muted { color: var(--muted); }
.bad { color: var(--bad); } .ok { color: var(--ok); } .warn { color: var(--warn); }
button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--bg); cursor: pointer; }
button.secondary { background: transparent; color: var(--accent); }
button:disabled { opacity: .5; cursor: not-allowed; }
select, input[type=text] { font: inherit; padding: 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); max-width: 100%; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
td, th { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
code, strong { overflow-wrap: anywhere; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.steps { list-style: none; padding-left: 0; }
.steps li::before { display: inline-block; width: 1.5em; content: "·"; }
.steps li.done::before { content: "✓"; color: var(--ok); }
.steps li.now::before { content: "•"; color: var(--accent); }
.steps li.fail::before { content: "✕"; color: var(--bad); }
.steps li.todo { color: var(--muted); }
details { margin-top: 12px; }
#qr img { width: 200px; height: 200px; background: #fff; }
ol, ul { padding-left: 20px; }
[hidden] { display: none !important; }
`;

export const ONBOARDING_SCRIPT = `const $ = (id) => document.getElementById(id);
const SECTIONS = ["s-connect", "s-account", "s-domain", "s-progress", "s-review", "s-done"];
const ui = { accounts: null, accountId: null, zones: null, review: null, approvalId: null, reasons: [], target: null, sawProgress: false };
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const fill = (node, items) => { node.replaceChildren(...items); };
const showError = (msg) => { $("error").textContent = msg || ""; };
const show = (id) => { for (const s of SECTIONS) $(s).hidden = s !== id; };
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
async function api(path, body) {
  const init = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(path, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error || "request failed") + (data.nextAction ? " — " + data.nextAction : ""));
  return data;
}
function row(k, v) { const tr = el("tr"); tr.append(el("th", k), el("td", v)); return tr; }

function renderSteps(state, op, host) {
  const failed = state === "failed" || state === "interrupted";
  const at = { "target-selected": 0, planning: 0, deploying: 1, verifying: 3, ready: 4 }[state];
  let reached = at === undefined ? (op ? { revalidate: 0, apply: 1, reconcile: 2, health: 3, done: 4 }[op.step] ?? 0 : 0) : at;
  const steps = ["Preparing your Cloudflare account", "Creating Bye", "Connecting " + host, "Checking everything"];
  fill($("steps"), steps.map((t, i) => el("li", t, i < reached ? "done" : i === reached ? (failed ? "fail" : "now") : "todo")));
}

function renderOperation(s) {
  const op = s.operation;
  const i = s.installation;
  $("h-progress").textContent = "Creating Bye at " + (i.appHostname || (i.urls ? i.urls.app : "your account"));
  renderSteps(s.state, op, i.appHostname || "your Bye address");
  if (!op) return;
  $("op-status").textContent = "Operation " + op.id + ": " + op.status + " (" + op.step + ")";
  $("op-error").textContent = op.error ? op.error.message : "";
  $("op-next").textContent = op.error ? "Next: " + op.error.nextAction : "";
  $("retry-btn").hidden = !(op.status === "failed" || op.status === "interrupted" || op.status === "cancelled") || s.authorization.status !== "connected";
  ui.approvalId = op.approvalId;
  fill($("health"), op.health.map((h) => { const tr = el("tr"); tr.append(el("td", h.name), el("td", (h.ok ? "passed" : "failed") + " · " + h.detail + " · " + h.ms + " ms", h.ok ? "ok" : "bad")); return tr; }));
  fill($("outcomes"), op.outcomes.map((o) => row(o.logicalId, o.action + " — " + o.outcome)));
  fill($("progress"), s.progress.map((e) => el("li", e.at.slice(11, 19) + " " + e.detail)));
}

function renderManage(s) {
  const i = s.installation;
  const a = s.authorization;
  $("s-manage").hidden = !i.accountId && a.status === "none";
  $("bound").textContent = i.accountId ? "Account: " + (i.accountName || i.accountId) + (i.appHostname ? " · " + i.appHostname : " · stage " + i.stage) : "";
  $("release").textContent = s.pinnedRelease ? "Release " + s.pinnedRelease.version + " (" + s.pinnedRelease.commit.slice(0, 12) + ")" : "Release unavailable: " + s.releaseProblem;
  $("kit-btn").hidden = !i.accountId || !!i.recoveryKitIssuedAt;
  $("kit-issued").textContent = i.recoveryKitIssuedAt ? "Recovery kit downloaded " + i.recoveryKitIssuedAt.replace("T", " ").slice(0, 16) + " UTC." : "";
  $("auth-status").textContent = { none: "Not connected.", connected: "Connected.", expired: "Authorization expired.", disconnected: "Disconnected. Your deployed resources and data are unchanged." }[a.status];
  $("disconnect").hidden = a.status !== "connected";
  $("manage-connect").hidden = a.status === "connected" || a.status === "none";
  if (a.disconnect) $("disconnect-result").textContent = a.disconnect.revocation + (a.disconnect.inFlight ? " " + a.disconnect.inFlight : "");
}

async function loadAccounts() {
  if (ui.accounts === null) ui.accounts = (await api("/api/accounts")).accounts;
  return ui.accounts;
}

async function loadZones() {
  ui.zones = (await api("/api/zones?accountId=" + encodeURIComponent(ui.accountId))).zones;
  const has = ui.zones.length > 0;
  $("zones-box").hidden = !has;
  $("no-zones").hidden = has;
  fill($("zone"), ui.zones.map((z) => { const o = el("option", z.name); o.value = z.id; return o; }));
  updatePreview();
}

function updatePreview() {
  const z = (ui.zones || []).find((x) => x.id === $("zone").value);
  const label = $("label").value.trim().toLowerCase();
  $("zone-name").textContent = z ? z.name : "";
  const ok = !!z && LABEL.test(label);
  $("preview").textContent = ok ? "https://" + label + "." + z.name : "Enter a valid Bye address";
  $("preview").className = ok ? "" : "bad";
  $("create-btn").disabled = !ok;
}

async function refresh() {
  let s;
  try { s = await api("/api/status"); } catch (e) { showError(e.message); return; }
  renderManage(s);
  const i = s.installation;
  const a = s.authorization;
  fill($("creates"), s.whatByeCreates.map((p) => el("li", p)));
  if (s.state === "ready") {
    show("s-done");
    $("app-link").textContent = i.urls.app; $("app-link").href = i.urls.app;
    if (s.handoff) {
      $("open-link").href = s.handoff.link;
      const img = el("img"); img.alt = "QR code for " + s.handoff.url; img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s.handoff.qrSvg);
      fill($("qr"), [img]);
    }
    // Hand off to the first-owner screen once per browser session; the button stays as a fallback.
    let handed = false; try { handed = sessionStorage.getItem("bye-owner-handoff") === i.id; } catch {}
    if (!handed && ui.sawProgress) { try { sessionStorage.setItem("bye-owner-handoff", i.id); } catch {} openOwnerSetup(); }
    return;
  }
  const running = ["planning", "deploying", "verifying"].includes(s.state);
  if (a.status !== "connected" && !running && !i.accountId) {
    show("s-connect");
    $("connect").textContent = a.status === "none" ? "Continue with Cloudflare" : "Reconnect Cloudflare";
    $("auth-note").textContent = a.status === "expired" ? "Your Cloudflare authorization expired. Reconnect to continue." : a.status === "disconnected" ? "Cloudflare is disconnected. Your deployed resources and data are unchanged." : "";
    return;
  }
  // Needs review (the standard plan could not be approved by policy, or the installation was
  // bound by stage): the full plan review.
  if ((s.state === "needs-review" && i.pendingReviewId) || (i.accountId && !i.appHostname && !s.operation)) {
    show("s-review");
    const reasons = ui.reasons.length ? ui.reasons : i.appHostname ? [] : ["This installation was bound to stage " + i.stage + "; review and approve its plan."];
    fill($("review-reasons"), reasons.map((r) => el("li", r)));
    showReconnect(a, $("review-btn"));
    return;
  }
  if (i.accountId) {
    show("s-progress");
    if (s.operation || running) ui.sawProgress = true;
    renderOperation(s);
    if (!s.operation && !running && i.appHostname) {
      // Bound, but "Create Bye" stopped before a deployment started: resume the recorded target.
      ui.target = { accountId: i.accountId, zoneId: i.zoneId, label: i.appHostname.slice(0, -(i.zoneName.length + 1)) };
      $("retry-btn").hidden = a.status !== "connected";
    }
    // Failures whose next step is a fresh review (release or plan changed, reconcile mismatch,
    // interrupted process) get the review path, not only a retry of the same approval.
    const op = s.operation;
    $("review-again-btn").hidden = !(op && a.status === "connected" && (op.status === "interrupted" || ((op.status === "failed" || op.status === "cancelled") && (op.step === "revalidate" || op.step === "reconcile" || /review/i.test(op.error ? op.error.nextAction : "")))));
    showReconnect(a, null);
    if (running) setTimeout(refresh, 3000);
    return;
  }
  try {
    const accounts = await loadAccounts();
    if (accounts.length === 0) { showError("This Cloudflare authorization has no accounts. Reconnect with an account you administer."); show("s-connect"); return; }
    if (ui.accountId === null && accounts.length === 1) ui.accountId = accounts[0].id;
    if (ui.accountId === null) {
      show("s-account");
      fill($("account"), accounts.map((acc) => { const o = el("option", acc.name); o.value = acc.id; return o; }));
      return;
    }
    show("s-domain");
    if (ui.zones === null) await loadZones();
  } catch (e) { showError(e.message); }
}

// An expired or disconnected authorization keeps the installation; reconnecting returns here.
function showReconnect(a, gated) {
  const off = a.status !== "connected";
  $("reconnect-btn").hidden = !off;
  if (off) $("op-next").textContent = a.status === "expired" ? "Your Cloudflare authorization expired. Reconnect to continue; nothing already created is changed." : "Cloudflare is disconnected. Reconnect to continue; your resources and data are unchanged.";
  if (gated) gated.disabled = off;
  if (off && gated) $("review-reasons").append(el("li", "Reconnect Cloudflare (Recovery and connection) to review the plan."));
}

async function openOwnerSetup() {
  try { const { link } = await api("/api/first-account", {}); location.assign(link); } catch (e) { showError(e.message); }
}

$("manage-connect").onclick = () => $("reconnect-btn").onclick();
$("reconnect-btn").onclick = async () => { try { const { url } = await api("/api/authorize", {}); location.href = url; } catch (e) { showError(e.message); } };
$("review-again-btn").onclick = () => { ui.reasons = ["The last deployment stopped at a step that needs a fresh review of the plan."]; show("s-review"); fill($("review-reasons"), ui.reasons.map((r) => el("li", r))); $("review-btn").click(); };
$("connect").onclick = async () => { try { const { url } = await api("/api/authorize", {}); location.href = url; } catch (e) { showError(e.message); } };
$("account-btn").onclick = () => { ui.accountId = $("account").value; ui.zones = null; refresh(); };
$("zone").onchange = updatePreview;
$("label").oninput = updatePreview;
$("refresh-zones").onclick = async () => { try { await loadZones(); showError(""); } catch (e) { showError(e.message); } };
$("create-btn").onclick = async () => {
  $("create-btn").disabled = true; showError("");
  show("s-progress"); ui.sawProgress = true;
  const z = ui.zones.find((x) => x.id === $("zone").value);
  $("h-progress").textContent = "Creating Bye at " + $("label").value.trim().toLowerCase() + "." + (z ? z.name : "");
  renderSteps("planning", null, $("label").value.trim().toLowerCase() + "." + (z ? z.name : ""));
  try {
    const r = await api("/api/install", { accountId: ui.accountId, zoneId: $("zone").value, label: $("label").value.trim().toLowerCase() });
    if (r.status === "needs-review") ui.reasons = r.reasons || [];
  } catch (e) { showError(e.message); }
  $("create-btn").disabled = false;
  refresh();
};
$("disconnect").onclick = async () => {
  if (!confirm("Disconnect Cloudflare? Active deployment work stops and stored credentials are deleted. Resources and data stay in your account.")) return;
  try { await api("/api/disconnect", {}); showError(""); refresh(); } catch (e) { showError(e.message); }
};
$("review-btn").onclick = async () => {
  $("review-btn").disabled = true;
  try {
    const r = await api("/api/review", {});
    ui.review = r;
    const sj = r.subject;
    fill($("review-summary"), [row("Account", sj.accountId), row("Stage", sj.stage), row("Release", sj.release.version + " (" + sj.release.commit.slice(0, 12) + ")"), row("Migrations", sj.migrations.length ? sj.migrations.join(", ") : "none"), row("Plan", r.digest.slice(0, 16))]);
    fill($("changes"), sj.actions.length ? sj.actions.map((c) => { const tr = el("tr"); tr.append(el("td", c.action, c.action === "delete" || c.action === "replace" ? "bad" : ""), el("td", c.logicalId), el("td", c.type)); return tr; }) : [row("No changes", "")]);
    $("blockers-box").hidden = r.blockers.length === 0; fill($("blockers"), r.blockers.map((b) => el("li", b)));
    $("warnings-box").hidden = r.warnings.length === 0; fill($("warnings"), r.warnings.map((w) => el("li", w)));
    $("ack-row").hidden = r.destructive.length === 0;
    $("approve-btn").disabled = r.blockers.length > 0;
    $("review").hidden = false;
    showError("");
  } catch (e) { showError(e.message); }
  $("review-btn").disabled = false;
};
$("approve-btn").onclick = async () => {
  const r = ui.review; if (!r) return;
  try {
    const a = await api("/api/approve", { reviewId: r.id, digest: r.digest, acknowledgeDestructive: $("ack").checked });
    await api("/api/deploy", { approvalId: a.id });
    $("review").hidden = true; showError(""); refresh();
  } catch (e) { showError(e.message); }
};
$("kit-btn").onclick = async () => {
  if (!confirm("The recovery kit is issued only once. Save the file somewhere safe — continue?")) return;
  try {
    const kit = await api("/api/recovery-kit", {});
    const a = el("a"); a.download = "bye-recovery-kit.json";
    a.href = URL.createObjectURL(new Blob([JSON.stringify(kit, null, 2)], { type: "application/json" }));
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showError(""); refresh();
  } catch (e) { showError(e.message); }
};
$("first-btn").onclick = openOwnerSetup;
$("retry-btn").onclick = async () => {
  $("retry-btn").disabled = true;
  try {
    // A failed deployment resumes with its approval; a stopped "Create Bye" re-runs with the recorded target.
    if (ui.approvalId) await api("/api/deploy", { approvalId: ui.approvalId });
    else if (ui.target) { const r = await api("/api/install", ui.target); if (r.status === "needs-review") ui.reasons = r.reasons || []; }
    showError("");
  } catch (e) { showError(e.message); }
  $("retry-btn").disabled = false;
  refresh();
};
$("guide-btn").onclick = async () => {
  try {
    const g = await api("/api/guide");
    const parts = [el("p", g.notice, "warn")];
    for (const s of g.sections) {
      const d = el("details"); d.append(el("summary", s.title), el("p", s.summary));
      for (const [label, items] of [["Before", s.before], ["Steps", s.steps], ["Check", s.checks], ["Roll back", s.rollback]]) {
        d.append(el("h4", label)); const list = el("ol"); list.append(...items.map((x) => el("li", x))); d.append(list);
      }
      parts.push(d);
    }
    fill($("guide"), parts);
  } catch (e) { showError(e.message); }
};
const qp = new URLSearchParams(location.search);
if (qp.get("error")) showError("Cloudflare authorization failed: " + qp.get("error"));
refresh();
`;
