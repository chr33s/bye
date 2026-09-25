import { describe, expect, it } from "vitest";
import {
  isForbiddenIp,
  isForbiddenProxyTarget,
  signProxyUrl,
  verifyProxyUrl,
} from "@bye/mail-codec";

describe("image proxy", () => {
  it("[E23] blocks SSRF targets including numeric IPv4 encodings and IPv6 forms", () => {
    const forbidden = [
      "http://127.0.0.1/x",
      "http://2130706433/x",
      "http://0x7f.1/x",
      "http://0177.0.0.1/x",
      "http://10.0.0.5/",
      "http://169.254.169.254/latest/meta-data",
      "http://metadata.google.internal/",
      "http://172.31.255.1/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fe80::1]/",
      "http://[fd00::1]/",
      "http://localhost/",
      "http://printer.local/",
      "http://intranet/",
      "https://user:pw@cdn.example/x",
      "https://cdn.example:8443/x",
      "ftp://cdn.example/x",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
    ];
    for (const url of forbidden) expect(isForbiddenProxyTarget(url), url).toBe(true);
    for (const url of [
      "https://cdn.example/a.png",
      "http://images.example.org:80/b.gif",
      "https://[2606:4700::1111]/x",
    ]) {
      expect(isForbiddenProxyTarget(url), url).toBe(false);
    }
  });

  it("[E23] checks DNS-resolved addresses for rebinding", () => {
    expect(isForbiddenIp("10.1.2.3")).toBe(true);
    expect(isForbiddenIp("::ffff:a00:1")).toBe(true);
    expect(isForbiddenIp("64:ff9b::7f00:1")).toBe(true);
    expect(isForbiddenIp("93.184.216.34")).toBe(false);
    expect(isForbiddenIp("2606:4700::1111")).toBe(false);
  });

  it("[E23] signs and verifies proxy URLs and rejects tampering", async () => {
    const key = "test-key-material";
    const signed = await signProxyUrl("https://cdn.example/a.png?x=1", key);
    expect(await verifyProxyUrl(signed, key)).toBe("https://cdn.example/a.png?x=1");
    expect(await verifyProxyUrl(signed, "other-key")).toBeNull();
    const other = await signProxyUrl("https://cdn.example/b.png", key);
    const swapped = `${signed.split("&")[0]}&${other.split("&")[1]}`;
    expect(await verifyProxyUrl(swapped, key)).toBeNull();
    expect(await verifyProxyUrl(await signProxyUrl("http://127.0.0.1/", key), key)).toBeNull();
  });
});
