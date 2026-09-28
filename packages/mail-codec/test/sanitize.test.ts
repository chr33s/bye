import { describe, expect, it } from "vitest";
import {
  htmlToReadableText,
  htmlToText,
  sanitizeCss,
  sanitizeHtml,
  type SanitizeOptions,
} from "@bye/mail-codec";

const opts: SanitizeOptions = {
  proxyImage: (url) => `https://img.proxy.example/p?u=${encodeURIComponent(url)}`,
  cid: (id) => (id === "known@x" ? `/parts/${encodeURIComponent(id)}` : null),
  blockRemoteImages: false,
};

const clean = (html: string, o: Partial<SanitizeOptions> = {}) =>
  sanitizeHtml(html, { ...opts, ...o });

describe("sanitizeHtml", () => {
  it("[E23] removes scripts, handlers, frames, forms and embedded documents", () => {
    const { html } = clean(
      `<div onclick="x()" onmouseover=y>ok<script>alert(1)</script><SCRIPT src=//e></SCRIPT><iframe src="//e"></iframe>` +
        `<form action="//e"><input name=a><button>b</button></form><object data=x></object><svg><script>1</script><a href="javascript:1">s</a></svg>` +
        `<base href="//e"><meta http-equiv="refresh" content="0;url=//e"><link rel=stylesheet href=//e>end</div>`,
    );

    expect(html).toBe("<div>okbend</div>");
  });

  it("[E23] rejects obfuscated javascript: and data: links but keeps safe ones", () => {
    const { html } = clean(
      `<a href="jav&#x09;ascript:alert(1)">1</a><a href=" JaVaScRiPt:alert(1)">2</a><a href="&#106;avascript:x">3</a>` +
        `<a href="data:text/html,<script>">4</a><a href="vbscript:x">5</a><a href="https://ok.example/?a=1&amp;b=2">6</a><a href="mailto:a@b.c">7</a>`,
    );

    expect(html).not.toMatch(/javascript|vbscript|data:/i);
    expect(html).toContain(
      '<a href="https://ok.example/?a=1&amp;b=2" rel="noopener noreferrer" target="_blank">6</a>',
    );
    expect(html).toContain('href="mailto:a@b.c"');
  });

  it("[E23] strips dangerous CSS including escaped expressions, imports and fixed positioning", () => {
    const { html } = clean(
      `<style>@import url(//evil.example/x.css); .a { color: red; width: expr\\65 ssion(alert(1)); } .b { position: fixed; top: 0 } @font-face { src: url(//f) }</style>` +
        `<p style="color:blue; background:url(javascript:alert(1)); behavior:url(x.htc); -moz-binding:url(x)">t</p>` +
        `<p style="position: fixed; color: green">u</p>`,
    );

    expect(html).not.toMatch(/import|expression|javascript|behavior|binding|fixed|font-face/i);
    expect(html).toContain("color: red");
    expect(html).toContain('<p style="color: blue">t</p>');
    expect(html).toContain('<p style="color: green">u</p>');
  });

  it("[E23] rewrites cid: and remote images through the proxy and drops unknown parts", () => {
    const result = clean(
      `<img src="cid:known@x" alt="logo"><img src="cid:missing@x"><img src="https://cdn.example/banner.png" width="600">`,
    );

    expect(result.html).toContain('<img src="/parts/known%40x" alt="logo">');
    expect(result.html).not.toContain("missing");
    expect(result.html).toContain(
      "https://img.proxy.example/p?u=https%3A%2F%2Fcdn.example%2Fbanner.png",
    );
    expect(result.remoteImages).toEqual(["https://cdn.example/banner.png"]);
  });

  it("[E23] blocks remote images when disabled, including CSS backgrounds", () => {
    const result = clean(
      `<img src="https://cdn.example/a.png"><td style="background: url('https://cdn.example/b.png'); color: red">x</td>`,
      {
        blockRemoteImages: true,
      },
    );

    expect(result.html).not.toContain("cdn.example");
    expect(result.html).toContain('style="color: red"');
    expect(result.remoteImages).toEqual(["https://cdn.example/a.png", "https://cdn.example/b.png"]);
  });

  it("[E23] removes tracking pixels by size, visibility and known tracker host", () => {
    const result = clean(
      `<img src="https://news.example/o.gif?id=1" width="1" height="1"><img src="https://news.example/x.gif" style="display:none">` +
        `<img src="https://sub.mailtrack.io/trace/abc"><img src="https://x.list-manage.com/track/open.php?u=1"><img src="https://cdn.example/photo.jpg">`,
    );

    expect(result.blockedTrackers).toHaveLength(4);
    expect(result.html).toBe(
      `<img src="https://img.proxy.example/p?u=https%3A%2F%2Fcdn.example%2Fphoto.jpg">`,
    );
  });

  it("[E23] keeps safe raster data images and drops active SVG data", () => {
    const { html } = clean(
      `<img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/svg+xml;base64,PHN2Zz4=">`,
    );

    expect(html).toBe('<img src="data:image/png;base64,iVBORw0KGgo=">');
  });

  it("[E23] escapes text, drops comments and handles unclosed raw-text elements", () => {
    const { html } = clean(
      `<p>a &lt;b&gt; &amp; <!--[if mso]><script>x</script><![endif]--> c</p><script>never closed <p>hidden</p>`,
    );

    expect(html).toBe("<p>a &lt;b&gt; &amp;  c</p>");
  });

  it("drops disallowed attributes and escapes attribute values", () => {
    const { html } = clean(
      `<td id="x" class='k"><script>' background="https://e/x" width="10">z</td>`,
    );

    expect(html).toBe('<td class="k&quot;&gt;&lt;script&gt;" width="10">z</td>');
  });
});

describe("htmlToText", () => {
  it("extracts readable text with block structure", () => {
    expect(
      htmlToText(
        `<html><head><title>T</title><style>p{}</style></head><body><h1>Hi</h1><p>One&nbsp;two<br>three</p><ul><li>a</li><li>b</li></ul></body></html>`,
      ),
    ).toBe("Hi\n\nOne two\nthree\n\n- a\n- b");
  });
});

describe("stylesheet structure", () => {
  const css = (html: string) => sanitizeHtml(html, { ...opts, blockRemoteImages: true });
  it("[E23] an unclosed final rule can't smuggle an unsanitized url()", () => {
    const out = css(
      "<style>p{color:red} a{background:url(https://tracker.example/p.gif)</style><p>x</p>",
    );

    expect(out.html).not.toContain("tracker.example");
    expect(out.html).toContain("color: red");
  });

  it("[E23] declarations beside nested rules (CSS nesting) are sanitized too", () => {
    const out = css(
      "<style>a{background:url(https://tracker.example/n.gif); b{color:blue}}</style><p>x</p>",
    );

    expect(out.html).not.toContain("tracker.example");
    expect(out.html).toContain("color: blue");
  });

  it("[E23] url() in a selector or prelude is neutralized; stray braces are dropped", () => {
    const out = css("<style>}a[x=url(https://t.example/s)]{color:red}</style><p>x</p>");
    expect(out.html).not.toContain("t.example");
  });

  it("[E23] image-set() and other bare-string image functions can't bypass the image proxy", () => {
    const out = css(
      `<style>a{background:-webkit-image-set("https://t.example/q.gif" 1x); color:red}</style>` +
        `<p style="background-image: image-set('https://t.example/r.gif' 1x); color: blue">x</p>` +
        `<p style="background: image('https://t.example/s.gif')">y</p>` +
        `<p style="background: src('https://t.example/u.gif')">z</p>`,
    );

    expect(out.html).not.toContain("t.example");
    expect(out.html).toContain("color: red");
    expect(out.html).toContain('style="color: blue"');
  });

  it("[E23] escaped or unclosed comment openers can't hide structure from the sanitizer", () => {
    const out = css(
      "<style>a{color:red; width: 1px \\2f\\2a}b{background:url(https://t.example/c.gif)}</style>" +
        '<p style="color: green; margin: 0 /*">x</p>',
    );

    expect(out.html).not.toContain("/*");
    expect(out.html).not.toContain("t.example");
    expect(out.html).toContain("color: red");
    expect(out.html).toContain("color: green");
  });

  it("[E23] braces inside quoted strings are not rule structure", () => {
    const out = css(
      `<style>a{content:"}"; color:red} b{content:"{"; position:fixed; color:blue}</style><p>x</p>`,
    );

    expect(out.html).toContain('content: "}"; color: red');
    expect(out.html).toContain('content: "{"; color: blue');
    expect(out.html).not.toContain("fixed");
  });

  it("[E23] a self-closing <style/> or <script/> still opens a raw-text element, as in browsers", () => {
    expect(clean("<p>a</p><script/><img src=x onerror=alert(1)><p>b</p>").html).toBe("<p>a</p>");
    const style = css("<style/>p{background:url(https://t.example/d.gif)}</style><p>x</p>");
    expect(style.html).not.toContain("t.example");
    expect(style.html).toContain("<p>x</p>");
  });

  it("[O05] pages holding several messages can drop <style> blocks entirely", () => {
    const out = sanitizeHtml('<style>article{display:none}</style><p style="color:red">x</p>', {
      ...opts,
      blockRemoteImages: true,
      allowStyleBlocks: false,
    });

    expect(out.html).not.toContain("<style");
    expect(out.html).not.toContain("display:none");
    expect(out.html).toContain("color: red");
  });

  // Output is re-serialized from tokens, so what matters is that nothing the input parser treated
  // as raw text can come back out as markup, and that foreign-content (svg/math) subtrees are
  // dropped wholesale rather than interpreted with HTML rules the browser would not apply.
  describe("[E23] mXSS and namespace confusion", () => {
    const px = (u: string) => `https://img.proxy.example/p?u=${encodeURIComponent(u)}`;

    it("drops <svg>/<math> subtrees, including a <style> the browser would parse as markup", () => {
      expect(clean("<svg><style><img src=x onerror=alert(1)></style></svg>after").html).toBe(
        "after",
      );
      expect(
        clean("<math><style><img src=https://a.example/x.png onerror=alert(1)></style></math>ok")
          .html,
      ).toBe("ok");
      expect(clean("<SVG><sCrIpT>alert(1)</ScRiPt></svg>after").html).toBe("after");
      expect(clean("<svg><foreignObject><p>x</p></foreignObject></svg>after").html).toBe("after");
    });

    it("an early </p> or unclosed foreign element drops the rest instead of re-interpreting it", () => {
      // Browsers leave foreign content on </p>; the sanitizer stays conservative and drops to EOF.
      expect(clean('<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">').html).toBe("");
      expect(clean("<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>").html).toBe(
        "",
      );
      expect(
        clean("<svg><style></svg><img src=https://a.example/x.png onerror=1></style>tail").html,
      ).toBe("");
    });

    it("raw-text containers (<noscript>, <textarea>, <xmp>, <title>) never leak their content", () => {
      expect(clean("<textarea><img src=x onerror=alert(1)></textarea>ok").html).toBe("ok");
      expect(clean("<xmp><img src=x onerror=alert(1)></xmp>ok").html).toBe("ok");
      expect(clean("<title><img src=https://a.example/x.png></title>ok").html).toBe("ok");

      // The raw text ends at the first </noscript>, as in a scripting-enabled browser; what follows
      // is ordinary markup and is sanitized as such (handler dropped, image proxied).
      const ns = clean(
        '<noscript><p title="</noscript><img src=https://a.example/x.png onerror=alert(1)>">',
      ).html;

      expect(ns).toBe(`<img src="${px("https://a.example/x.png")}">"&gt;`);
      expect(ns).not.toMatch(/onerror|noscript/);
    });

    it("markup-looking text inside <style> can't escape it", () => {
      const a = clean("<p><style><img src=x onerror=alert(1)></style></p>").html;
      expect(a).toBe("<p><style></style></p>");
      const b = clean("<style><!--</style><img src=x onerror=1>--></style>").html;
      expect(b).not.toMatch(/<img|onerror/);
      expect(b.startsWith("<style></style>")).toBe(true);
    });
  });

  it("[E23] srcset and formaction are dropped rather than passed through unproxied", () => {
    const img = clean(
      '<img src="https://a.example/x.png" srcset="https://b.example/y.png 2x, javascript:alert(1) 3x">',
    );

    expect(img.html).toBe(
      `<img src="https://img.proxy.example/p?u=${encodeURIComponent("https://a.example/x.png")}">`,
    );
    expect(img.remoteImages).toEqual(["https://a.example/x.png"]);

    const forms = clean(
      '<a href="https://ok.example" formaction="javascript:alert(1)">x</a><button formaction="https://e">b</button><input type=image formaction=//e src=//e>',
    ).html;

    expect(forms).toBe(
      '<a href="https://ok.example" rel="noopener noreferrer" target="_blank">x</a>b',
    );
  });
});

describe("sanitizeCss", () => {
  it("proxies url(), records remote images and trackers, and drops dangerous declarations", () => {
    const out = sanitizeCss(
      'a { background: url("https://x.example/a.png"); width: expression(1) } b { color: red } c{background:url(https://mailtrack.io/t/x)}',
      opts,
    );

    expect(out.css).toBe(
      `a { background: url("https://img.proxy.example/p?u=${encodeURIComponent("https://x.example/a.png")}") }\nb { color: red }\nc {  }\n`,
    );
    expect(out.remoteImages).toEqual(["https://x.example/a.png"]);
    expect(out.blockedTrackers).toEqual(["https://mailtrack.io/t/x"]);
  });

  it("drops remote url() when images are blocked, and strips at-rules and markup", () => {
    const out = sanitizeCss(
      "@import url(//e/x.css); @charset 'x'; @font-face{src:url(//f)} a { background: url(https://x.example/a.png); color: red } </style><script>",
      { ...opts, blockRemoteImages: true },
    );

    expect(out.css).toBe("a { color: red }\n");
    expect(out.remoteImages).toEqual(["https://x.example/a.png"]);
  });

  it("[E23] CSS escapes decode in one pass: an escaped backslash can't build a second escape", () => {
    for (const css of [
      "a { background: \\5c \\5c 75rl(https://evil.example/x.png) }",
      "a { background: \\5c 75rl(https://evil.example/x.png) }",
      "a { background: \\\\75rl(https://evil.example/x.png) }",
      "a { width: \\5c 65xpression(alert(1)) }",
    ]) {
      const out = sanitizeCss(css, { ...opts, blockRemoteImages: true });
      // No backslash survives to be re-decoded by the browser, and nothing reached a url().
      expect(out.css, css).not.toMatch(/\\/);
      expect(out.css, css).not.toMatch(/url\(|expression/i);
    }

    const { html } = clean(
      `<p style="background: \\5c \\5c 75rl(https://evil.example/x.png); color: red">x</p>`,
      { blockRemoteImages: true },
    );

    expect(html).not.toMatch(/\\|url\(/i);
    // Ordinary escapes still decode.
    expect(sanitizeCss("a { color: \\72 ed }", opts).css).toContain("color: red");
  });

  it("decodes CSS escapes before checking, and neutralizes comment openers", () => {
    const out = sanitizeCss(
      "a { width: expr\\65 ssion(alert(1)); color: blue } b { content: '\\2f\\2a'; color: green }",
      opts,
    );

    expect(out.css).not.toMatch(/expression|\/\*/);
    expect(out.css).toContain("color: blue");
    expect(out.css).toContain("color: green");
  });
});

describe("htmlToReadableText", () => {
  it("[X02] decodes entities, keeps preformatted text, and shows link targets", () => {
    expect(
      htmlToReadableText(
        `<head><title>t</title></head><p>One&nbsp;&amp;&#32;two</p><ul><li>a</li><li>b</li></ul><pre>  keep\n  lines</pre><p><a href="https://example.com/x">Read more</a> <a href="https://example.com">https://example.com</a> <a href="javascript:x()">no</a></p><script>x()</script>`,
      ),
    ).toBe(
      "One & two\n\n- a\n- b\n\n  keep\n  lines\n\nRead more <https://example.com/x> https://example.com no",
    );
  });
});
