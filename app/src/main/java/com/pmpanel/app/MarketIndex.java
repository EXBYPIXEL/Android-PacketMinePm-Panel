package com.pmpanel.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.zip.GZIPInputStream;

/**
 * Poggit plugin market index.
 *
 * The Poggit site (api.poggit.pmmp.io) is GONE in 2026 - poggit.pmmp.io now
 * redirects to the static GitHub repo poggit/release-archive which stores
 * every approved release as author/Plugin/Version/info.json + phar. The app
 * ships a compact index of that archive (built from info.json metadata) and
 * searches it locally; the phars are downloaded straight from
 * raw.githubusercontent.com (no auth, no rate limit issues).
 */
public final class MarketIndex {

    private static volatile JSONArray plugins;   // raw index entries
    private static volatile long builtAt = 0;

    private MarketIndex() {
    }

    public static final String BASE_URL =
            "https://raw.githubusercontent.com/poggit/release-archive/master/";

    /** Load (once) the bundled gz index; falls back to a previous download in filesDir. */
    public static synchronized boolean load(android.content.Context ctx) throws IOException {
        if (plugins != null) return true;
        byte[] json;
        File cached = new File(ctx.getFilesDir(), "poggit-index.json.gz");
        if (cached.isFile() && cached.length() > 20000) {
            /* refreshed copy downloaded later - still gzipped */
            byte[] raw = readAll(new FileInputStream(cached));
            json = gunzip(raw);
        } else {
            /* bundled plain JSON (aapt2 strips .gz from asset names, so the
             * bundled index ships uncompressed and is deflated by the APK) */
            InputStream in = ctx.getAssets().open("poggit-index.json");
            json = readAll(in);
            in.close();
        }
        JSONObject doc;
        try {
            doc = new JSONObject(new String(json, "UTF-8"));
        } catch (org.json.JSONException e) {
            throw new IOException("index file is corrupt: " + e.getMessage());
        }
        plugins = doc.optJSONArray("plugins");
        builtAt = doc.optLong("built", 0) * 1000L;
        return plugins != null && plugins.length() > 0;
    }

    /** Replace the bundled index with a freshly downloaded one (called on market.refresh). */
    public static synchronized void saveDownloaded(android.content.Context ctx, byte[] gz) {
        try {
            File f = new File(ctx.getFilesDir(), "poggit-index.json.gz");
            try (FileOutputStream fo = new FileOutputStream(f)) {
                fo.write(gz);
            }
            plugins = null; // force reload on next search
        } catch (Throwable ignored) {
        }
    }

    public static JSONObject meta() {
        JSONObject o = new JSONObject();
        try {
            o.put("count", plugins == null ? 0 : plugins.length());
            o.put("built", builtAt);
            o.put("source", "github.com/poggit/release-archive");
        } catch (Throwable ignored) {
        }
        return o;
    }

    /** q: free text (name/author/tagline); sort: downloads|name|updated. Returns up to limit rows. */
    public static List<JSONObject> search(String q, String sort, int limit) {
        JSONArray src = plugins;
        List<JSONObject> out = new ArrayList<>();
        if (src == null) return out;
        String needle = q == null ? "" : q.trim().toLowerCase(Locale.US);
        for (int i = 0; i < src.length(); i++) {
            JSONObject p = src.optJSONObject(i);
            if (p == null) continue;
            if (!needle.isEmpty()) {
                String hay = (p.optString("n") + " " + p.optString("a") + " " + p.optString("t"))
                        .toLowerCase(Locale.US);
                boolean hit = true;
                for (String w : needle.split("\\s+")) {
                    if (!w.isEmpty() && !hay.contains(w)) {
                        hit = false;
                        break;
                    }
                }
                if (!hit) continue;
            }
            out.add(p);
        }
        Comparator<JSONObject> cmp;
        if ("name".equals(sort)) {
            cmp = (a, b) -> a.optString("n").compareToIgnoreCase(b.optString("n"));
        } else if ("updated".equals(sort)) {
            cmp = (a, b) -> Long.compare(b.optLong("date"), a.optLong("date"));
        } else {
            cmp = (a, b) -> Long.compare(b.optLong("dl", b.optLong("d")), a.optLong("dl", a.optLong("d")));
        }
        out.sort(cmp);
        if (out.size() > limit) out.subList(limit, out.size()).clear();
        return out;
    }

    /** One entry by exact (lowercase) name - used for version listing. */
    public static JSONObject byName(String name) {
        JSONArray src = plugins;
        if (src == null || name == null) return null;
        String n = name.toLowerCase(Locale.US);
        for (int i = 0; i < src.length(); i++) {
            JSONObject p = src.optJSONObject(i);
            if (p != null && p.optString("n").toLowerCase(Locale.US).equals(n)) return p;
        }
        return null;
    }

    private static byte[] gunzip(byte[] raw) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(1024 * 1024);
        try (GZIPInputStream gz = new GZIPInputStream(new java.io.ByteArrayInputStream(raw))) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = gz.read(buf)) > 0) out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        try {
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
            }
        }
        return bos.toByteArray();
    }
}
