// Consent step of the browser sign-in (subflows/sign-in.yaml), run by Maestro's GraalJS.
// In:  maestro.copiedText — the browser address: /oauth/authorize?… or /?next=/oauth/authorize?…
//      E2E_SESSION_COOKIE — the test account's `__Host-session` cookie value.
// Out: output.callbackUrl — the bye://oauth/callback URL the server redirected to.

function parseQuery(query) {
  var params = {};
  var pairs = (query || "").split("#")[0].split("&");
  for (var i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue;
    var at = pairs[i].indexOf("=");
    var key = decodeURIComponent((at < 0 ? pairs[i] : pairs[i].slice(0, at)).replace(/\+/g, " "));
    params[key] = at < 0 ? "" : decodeURIComponent(pairs[i].slice(at + 1).replace(/\+/g, " "));
  }
  return params;
}

function queryOf(url) {
  var at = url.indexOf("?");
  return at < 0 ? "" : url.slice(at + 1);
}

var address = String(maestro.copiedText || "").trim();
if (!/^https?:\/\//.test(address)) address = "https://" + address;
var origin = address.match(/^https?:\/\/[^/?#]+/)[0];

var params = parseQuery(queryOf(address));
// Unauthenticated, the server sends the browser to the web sign-in page with the request in `next`.
if (params.next && params.next.indexOf("/oauth/authorize?") === 0) {
  params = parseQuery(queryOf(params.next));
}
if (!params.state || !params.code_challenge || !params.redirect_uri) {
  throw new Error("browser address is not an authorization request: " + address);
}

var form = [];
for (var key in params) {
  if (key !== "decision")
    form.push(encodeURIComponent(key) + "=" + encodeURIComponent(params[key]));
}
// The submit button is appended last, as a browser would (the server trusts only the last one).
form.push("decision=allow");

var response = http.post(origin + "/oauth/authorize", {
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: "__Host-session=" + E2E_SESSION_COOKIE,
    // Cookie-authenticated POSTs must be same-origin (checkCsrf).
    Origin: origin,
  },
  body: form.join("&"),
});

// OkHttp does not follow a redirect to a non-HTTP scheme, so the 303 comes back as-is.
var location = null;
for (var name in response.headers) {
  if (name.toLowerCase() === "location") location = String(response.headers[name]);
}
if (response.status !== 303 || !location || location.indexOf("bye://oauth/callback?") !== 0) {
  throw new Error(
    "consent failed (" +
      response.status +
      "); is E2E_SESSION_COOKIE current? " +
      String(response.body).slice(0, 200),
  );
}
if (location.indexOf("code=") < 0) throw new Error("consent was denied: " + location);

output.callbackUrl = location;
