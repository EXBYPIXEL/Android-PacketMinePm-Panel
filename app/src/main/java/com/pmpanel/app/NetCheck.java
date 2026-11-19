package com.pmpanel.app;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.InetAddress;
import java.net.URL;
import java.net.HttpURLConnection;

/**
 * Connectivity self-test used by the pack-fetcher / fake-player tools: the user
 * asked "check whether the app even has internet at all" - this probes DNS,
 * plain HTTPS (cloudflare reachability) and the GitHub hosts the app actually
 * uses, each with its own result + latency so a blocked network is obvious.
 */
public final class NetCheck {

    private NetCheck() {
    }

    public static JSONObject run() throws org.json.JSONException {
        JSONObject r = ServerManager.JO("ok", true);
        // 1) DNS
        long t0 = System.currentTimeMillis();
        try {
            InetAddress a = InetAddress.getByName("raw.githubusercontent.com");
            r.put("dns", true);
            r.put("dnsMs", System.currentTimeMillis() - t0);
            r.put("dnsIp", a.getHostAddress());
        } catch (Throwable e) {
            r.put("dns", false);
            r.put("dnsError", Bridge.safeMsg(e));
        }
        // 2) general HTTPS (Cloudflare - reachable in most networks incl. Iran)
        String[] general = {"https://cp.cloudflare.com/generate_204", "https://www.google.com/generate_204"};
        boolean net = false;
        long netMs = -1;
        String via = "";
        String netErr = null;
        for (String u : general) {
            long s = System.currentTimeMillis();
            try {
                int code = probe(u, 4500);
                netMs = System.currentTimeMillis() - s;
                via = hostOf(u);
                net = true;
                netErr = null;
                break;
            } catch (Throwable e) {
                netErr = Bridge.safeMsg(e);
            }
        }
        r.put("https", net);
        r.put("httpsMs", netMs);
        r.put("via", via);
        if (netErr != null) r.put("httpsError", netErr);
        // 3) the hosts the app itself needs (pack downloads, index refresh, updates)
        JSONObject gh = new JSONObject();
        probeJson(gh, "raw.githubusercontent.com", "https://raw.githubusercontent.com/poggit/release-archive/master/README.md", 5000);
        probeJson(gh, "api.github.com", "https://api.github.com/repos/poggit/release-archive", 5000);
        try {
            r.put("github", gh);
        } catch (Throwable ignored) {
        }
        return r;
    }

    private static void probeJson(JSONObject o, String key, String url, int timeout) {
        long s = System.currentTimeMillis();
        try {
            int code = probe(url, timeout);
            o.put(key, code >= 200 && code < 400);
            o.put(key + "Code", code);
            o.put(key + "Ms", System.currentTimeMillis() - s);
        } catch (Throwable e) {
            try {
                o.put(key, false);
                o.put(key + "Error", Bridge.safeMsg(e));
            } catch (Throwable ignored) {
            }
        }
    }

    /** HEAD first, fall back to GET - some hosts reject HEAD. */
    private static int probe(String url, int timeoutMs) throws Exception {
        try {
            return doProbe(url, "HEAD", timeoutMs);
        } catch (Exception headFailure) {
            return doProbe(url, "GET", timeoutMs);
        }
    }

    private static int doProbe(String url, String method, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", "PMPanel/2.7");
            c.setRequestProperty("Connection", "close");
            int code = c.getResponseCode();
            try (InputStream ignored1 = c.getInputStream()) {
                // drain a little so the connection is really established
            } catch (Throwable ignored) {
            }
            return code;
        } finally {
            c.disconnect();
        }
    }

    private static String hostOf(String u) {
        try {
            return new URL(u).getHost();
        } catch (Throwable t) {
            return u;
        }
    }
}
