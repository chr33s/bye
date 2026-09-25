// The onboarding page: a document plus its same-origin stylesheet and script (served by server.ts
// at /app.css and /app.js), so the CSP needs no 'unsafe-inline'. All server data is rendered with
// textContent; the only markup inserted is the server-generated QR SVG, as an image.

export const ONBOARDING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deploy Bye to Cloudflare</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main>
  <h1>Deploy Bye to your Cloudflare account</h1>
  <p class="muted">Your account holds every resource and all data. Deploying never changes your domains or mail routing.</p>
  <p id="error" class="bad" role="alert"></p>

  <section id="s-prereq" aria-labelledby="h-prereq">
    <h2 id="h-prereq">1. Before you start</h2>
    <p>Release: <strong id="release">…</strong></p>
    <ul id="prereqs"></ul>
    <p class="muted">Access requested: Workers scripts, KV, D1, R2, Queues, Containers and Secrets Store (for the deployment state store), plus read access to your account list and settings. No DNS, zone, routes or Email Routing access.</p>
    <ul id="manual" class="muted"></ul>
  </section>

  <section id="s-auth" aria-labelledby="h-auth">
    <h2 id="h-auth">2. Connect Cloudflare</h2>
    <p id="auth-status"></p>
    <div class="row">
      <button id="connect">Connect Cloudflare</button>
      <button id="disconnect" class="secondary">Disconnect</button>
    </div>
    <p id="disconnect-result" class="muted"></p>
    <div id="bind" hidden>
      <p>Choose the account and stage. This cannot be changed after deployment starts.</p>
      <div class="row">
        <label>Account <select id="account"></select></label>
        <label>Stage <input id="stage" type="text" value="prod" size="16" aria-describedby="stage-help"></label>
        <button id="bind-btn">Use this account</button>
      </div>
      <p id="stage-help" class="muted">prod or staging for a real installation; dev-&lt;id&gt; for a trial.</p>
    </div>
    <p id="bound"></p>
    <div id="kit" hidden>
      <p>Download the recovery kit now and keep it somewhere safe. It holds this instance's generated secrets, so you can redeploy without this service. <strong>It can be downloaded only once.</strong> It contains no Cloudflare credentials.</p>
      <button id="kit-btn" class="secondary">Download recovery kit</button>
    </div>
    <p id="kit-issued" class="muted"></p>
  </section>

  <section id="s-review" aria-labelledby="h-review">
    <h2 id="h-review">3. Review and approve</h2>
    <button id="review-btn">Review deployment plan</button>
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

  <section id="s-deploy" aria-labelledby="h-deploy">
    <h2 id="h-deploy">4. Deploy and verify</h2>
    <p id="op-status" aria-live="polite">No deployment yet.</p>
    <p id="op-error" class="bad"></p>
    <p id="op-next"></p>
    <button id="retry-btn" hidden>Retry with the same approval</button>
    <table><thead><tr><th>Check</th><th>Result</th></tr></thead><tbody id="health"></tbody></table>
    <details><summary>Resources</summary><table><tbody id="outcomes"></tbody></table></details>
    <details><summary>Progress log</summary><ol id="progress" class="muted"></ol></details>
  </section>

  <section id="s-apps" aria-labelledby="h-apps" hidden>
    <h2 id="h-apps">5. Connect the Bye apps</h2>
    <p>Your instance: <code id="instance-url"></code></p>
    <div class="row"><a id="open-link" href="#">Open in Bye</a></div>
    <div id="qr"></div>
    <p class="muted">The link and code contain only this address. The app checks the server, asks you to confirm, then you sign in there directly.</p>
    <h3>First account</h3>
    <p>Create the instance's first account in your browser with a one-time setup link. That account becomes the operator. The link stops working once it has been used.</p>
    <button id="first-btn">Create the first account</button>
  </section>

  <section id="s-guide" aria-labelledby="h-guide">
    <h2 id="h-guide">6. Domains and mail (manual, optional)</h2>
    <button id="guide-btn" class="secondary">Show the guide</button>
    <div id="guide"></div>
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
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 0 0 8px; }
section { border-top: 1px solid var(--line); padding: 20px 0; }
.muted { color: var(--muted); }
.bad { color: var(--bad); } .ok { color: var(--ok); } .warn { color: var(--warn); }
button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--bg); cursor: pointer; }
button.secondary { background: transparent; color: var(--accent); }
button:disabled { opacity: .5; cursor: not-allowed; }
select, input[type=text] { font: inherit; padding: 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); max-width: 100%; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
td, th { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
code { font-size: .9em; overflow-wrap: anywhere; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
#qr img { width: 200px; height: 200px; background: #fff; }
ol, ul { padding-left: 20px; }
[hidden] { display: none !important; }
`;

export const ONBOARDING_SCRIPT = `const $ = (id) => document.getElementById(id);
let state = { approvalId: null, review: null };
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const fill = (node, items) => { node.replaceChildren(...items); };
const showError = (msg) => { $("error").textContent = msg || ""; };
async function api(path, body) {
  const init = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(path, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error || "request failed") + (data.nextAction ? " — " + data.nextAction : ""));
  return data;
}
function row(k, v) { const tr = el("tr"); tr.append(el("th", k), el("td", v)); return tr; }

async function refresh() {
  let s;
  try { s = await api("/api/status"); } catch (e) { showError(e.message); return; }
  $("release").textContent = s.pinnedRelease ? s.pinnedRelease.version + " (" + s.pinnedRelease.commit.slice(0, 12) + ")" : "unavailable: " + s.releaseProblem;
  fill($("prereqs"), s.prerequisites.map((p) => el("li", p)));
  fill($("manual"), s.manualSteps.map((p) => el("li", p)));
  const a = s.authorization;
  const authText = { none: "Not connected.", connected: "Connected.", expired: "Authorization expired — reconnect to continue.", disconnected: "Disconnected. Your deployed resources and data are unchanged." }[a.status];
  $("auth-status").textContent = authText;
  $("auth-status").className = a.status === "connected" ? "ok" : a.status === "none" ? "" : "warn";
  $("connect").textContent = a.status === "none" ? "Connect Cloudflare" : "Reconnect Cloudflare";
  $("connect").hidden = a.status === "connected";
  $("disconnect").hidden = a.status !== "connected";
  if (a.disconnect) $("disconnect-result").textContent = a.disconnect.revocation + (a.disconnect.inFlight ? " " + a.disconnect.inFlight : "");
  const i = s.installation;
  if (i.accountId) {
    $("bind").hidden = true;
    $("bound").textContent = "Account: " + (i.accountName || i.accountId) + " · stage " + i.stage + (i.urls ? " · " + i.urls.app : "");
  } else if (a.status === "connected") {
    $("bind").hidden = false;
    try {
      const { accounts } = await api("/api/accounts");
      fill($("account"), accounts.map((acc) => { const o = el("option", acc.name + " (" + acc.id.slice(0, 8) + "…)"); o.value = acc.id; return o; }));
    } catch (e) { showError(e.message); }
  }
  $("kit").hidden = !i.accountId || !!i.recoveryKitIssuedAt;
  $("kit-issued").textContent = i.recoveryKitIssuedAt ? "Recovery kit downloaded " + i.recoveryKitIssuedAt.replace("T", " ").slice(0, 16) + " UTC." : "";
  $("review-btn").disabled = !(i.accountId && a.status === "connected");
  const op = s.operation;
  if (op) {
    const label = { queued: "Queued", running: "Running: " + op.step, succeeded: "Ready", failed: "Failed at " + op.step, cancelled: "Stopped at " + op.step, interrupted: "Interrupted at " + op.step }[op.status];
    $("op-status").textContent = label + (i.ready ? " — deployment health checks passed" : "");
    $("op-status").className = op.status === "succeeded" ? "ok" : op.status === "failed" || op.status === "interrupted" ? "bad" : "";
    $("op-error").textContent = op.error ? op.error.message : "";
    $("op-next").textContent = op.error ? "Next: " + op.error.nextAction : "";
    $("retry-btn").hidden = !(op.status === "failed" || op.status === "interrupted" || op.status === "cancelled") || a.status !== "connected";
    state.approvalId = op.approvalId;
    fill($("health"), op.health.map((h) => { const tr = el("tr"); tr.append(el("td", h.name), el("td", (h.ok ? "passed" : "failed") + " · " + h.detail + " · " + h.ms + " ms", h.ok ? "ok" : "bad")); return tr; }));
    fill($("outcomes"), op.outcomes.map((o) => row(o.logicalId, o.action + " — " + o.outcome)));
    fill($("progress"), s.progress.map((e) => el("li", e.at.slice(11, 19) + " " + e.detail)));
    if (op.status === "queued" || op.status === "running") setTimeout(refresh, 3000);
  }
  $("s-apps").hidden = !s.handoff;
  if (s.handoff) {
    $("instance-url").textContent = s.handoff.url;
    $("open-link").href = s.handoff.link;
    const img = el("img"); img.alt = "QR code for " + s.handoff.url; img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s.handoff.qrSvg);
    fill($("qr"), [img]);
  }
}

$("connect").onclick = async () => { try { const { url } = await api("/api/authorize", {}); location.href = url; } catch (e) { showError(e.message); } };
$("disconnect").onclick = async () => {
  if (!confirm("Disconnect Cloudflare? Active deployment work stops and stored credentials are deleted. Resources and data stay in your account.")) return;
  try { await api("/api/disconnect", {}); showError(""); refresh(); } catch (e) { showError(e.message); }
};
$("bind-btn").onclick = async () => { try { await api("/api/bind", { accountId: $("account").value, stage: $("stage").value.trim() }); showError(""); refresh(); } catch (e) { showError(e.message); } };
$("review-btn").onclick = async () => {
  $("review-btn").disabled = true;
  try {
    const r = await api("/api/review", {});
    state.review = r;
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
  const r = state.review; if (!r) return;
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
$("first-btn").onclick = async () => {
  try { const { link } = await api("/api/first-account", {}); window.open(link, "_blank", "noopener"); } catch (e) { showError(e.message); }
};
$("retry-btn").onclick = async () => { try { await api("/api/deploy", { approvalId: state.approvalId }); showError(""); refresh(); } catch (e) { showError(e.message); } };
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
