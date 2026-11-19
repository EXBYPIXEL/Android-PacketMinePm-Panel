package com.pmpanel.app;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.net.URL;

/** Public IP / LAN IP detection for the Public IP tool. */
public final class PublicIpInfo {

    private static final String[] CHECK_URLS = {
            "https://api.ipify.org",
            "https://checkip.amazonaws.com",
            "https://ipv4.icanhazip.com",
    };

    private PublicIpInfo() {
    }

    /** Fetch the device's public IPv4; empty string when it cannot be detected. */
    public static String fetchPublicIp() {
        for (String u : CHECK_URLS) {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(u).openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setRequestProperty("User-Agent", "PMPanel-Android");
                int code = conn.getResponseCode();
                if (code == 200) {
                    InputStream in = conn.getInputStream();
                    byte[] buf = new byte[512];
                    int n = in.read(buf);
                    in.close();
                    String s = n <= 0 ? "" : new String(buf, 0, n, java.nio.charset.StandardCharsets.UTF_8).trim();
                    if (s.matches("\\d{1,3}(\\.\\d{1,3}){3}")) return s;
                }
            } catch (Throwable ignored) {
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        return "";
    }

    /** First site-local IPv4 of the device (LAN address), empty when offline. */
    public static String getLocalIp() {
        try {
            java.util.Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                java.util.Enumeration<java.net.InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    java.net.InetAddress a = addrs.nextElement();
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
                    return a.getHostAddress();
                }
            }
        } catch (Throwable ignored) {
        }
        return "";
    }

    /** server-port from server.properties (fallback 19132). */
    public static int serverPort(ServerManager sm) {
        try {
            org.json.JSONArray lines = sm.fs.readProperties("server.properties");
            for (int i = 0; i < lines.length(); i++) {
                JSONObject l = lines.optJSONObject(i);
                if (l != null && "server-port".equals(l.optString("key"))) {
                    try {
                        return Integer.parseInt(l.optString("value", "").trim());
                    } catch (Exception ignored) {
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        return 19132;
    }

    /** Whether the given file looks like a phar. */
    public static boolean looksLikePhar(File f) {
        return f.isFile() && f.getName().toLowerCase(java.util.Locale.US).endsWith(".phar");
    }
}
