package com.pmpanel.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * v2.8 plugin-market enrichment.
 *
 * For one release (path "author/Plugin/Version/<file>.phar" inside the
 * poggit/release-archive mirror) this fetches the release info.json:
 *   icon_url, repo_name, html_url, license, categories, keywords, tagline.
 * The plugin IMAGE is downloaded from icon_url (raw.githubusercontent.com)
 * and the plugin DESCRIPTION is the README of its GitHub repo
 * (raw.githubusercontent.com/<repo>/HEAD/README.md).
 *
 * Everything is cached under <filesDir>/poggit_meta/ keyed by
 * author/plugin/version, so reopening the market is instant and offline.
 * All network work runs on ONE daemon thread: the market list can request
 * dozens of icons without flooding the network, and replies stay ordered.
 * Results are pushed back into the WebView with pushEvent (async events).
 */
public final class MarketFetch {

    private static final ExecutorService POOL = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "pm-market-fetch");
        t.setDaemon(true);
        return t;
    });

    private static final long TTL_INFO_MS = 7L * 24 * 3600 * 1000;
    private static final long TTL_README_MS = 7L * 24 * 3600 * 1000;
    private static final long TTL_ICON_MS = 30L * 24 * 3600 * 1000;
    private static final int README_MAX = 20000;
    private static final int INFO_MAX = 65536;

    /** Poggit archive mirror used for info.json (same base as MarketIndex phars). */
    private static final String RAW_README = "https://raw.githubusercontent.com/";

    private MarketFetch() {
    }

    private static File cacheDir(android.content.Context ctx) {
        File d = new File(ctx.getFilesDir(), "poggit_meta");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    /** author/Plugin/Version/file.phar -> author/Plugin/Version (the release folder). */
    private static String releaseDirOf(String ph) {
        int i = ph == null ? -1 : ph.lastIndexOf('/');
        return i > 0 ? ph.substring(0, i) : null;
    }

    private static String safeKey(String releaseDir) {
        return releaseDir.replaceAll("[^A-Za-z0-9._()\\-]", "_");
    }

    /**
     * Queue the fetch for one release. Reply (pushEvent reqId):
     * {ok, name, icon:<abs path>|null, info:{repo,htmlUrl,license,categories,
     * keywords,tagline,official,abandoned,preRelease,obsolete,state}, readme:<text>|null}
     */
    public static void fetch(Bridge bridge, String reqId, String name, String ph, boolean wantReadme) {
        POOL.execute(() -> {
            JSONObject r;
            try {
                r = fetchNow(bridge.act, name, ph, wantReadme);
            } catch (Throwable t) {
                r = ServerManager.JO("ok", false, "error", Bridge.safeMsg(t), "name", name);
            }
            bridge.act.pushEvent(reqId, r);
        });
    }

    private static JSONObject fetchNow(android.content.Context ctx, String name, String ph, boolean wantReadme) {
        JSONObject r = ServerManager.JO("ok", true, "name", name);
        String rel = releaseDirOf(ph);
        File dir = cacheDir(ctx);
        File infoFile = rel == null ? null : new File(dir, safeKey(rel) + ".info.json");

        /* ---------- info.json ---------- */
        JSONObject info = null;
        if (infoFile != null) {
            try {
                if (!infoFile.isFile() || System.currentTimeMillis() - infoFile.lastModified() > TTL_INFO_MS
                        || infoFile.length() < 10) {
                    String url = MarketIndex.BASE_URL + rel + "/info.json";
                    Installer.downloadFile(url, infoFile, (Installer.ByteProgressListener) null);
                }
                String txt = readText(infoFile, INFO_MAX);
                info = new JSONObject(txt);
            } catch (Throwable t) {
                info = null;
            }
        }

        /* ---------- icon image ---------- */
        String iconUrl = info == null ? "" : info.optString("icon_url", "");
        if (iconUrl != null && (iconUrl.startsWith("https://") || iconUrl.startsWith("http://"))) {
            File iconFile = new File(dir, safeKey(rel) + ".icon");
            try {
                if (!iconFile.isFile() || iconFile.length() < 64
                        || System.currentTimeMillis() - iconFile.lastModified() > TTL_ICON_MS) {
                    Installer.downloadFile(iconUrl, iconFile, (Installer.ByteProgressListener) null);
                }
                /* Reply with a data: URL - <img> tags always render those, while
                 * file:// subresources are blocked on some WebView builds. */
                if (iconFile.isFile() && iconFile.length() > 64 && iconFile.length() < 400000) {
                    byte[] bytes = readBytes(iconFile);
                    r.put("iconData", "data:" + mimeOf(bytes) + ";base64,"
                            + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
                    r.put("icon", iconFile.getAbsolutePath());
                }
            } catch (Throwable ignored) {
            }
        }

        /* ---------- structured info for the detail card ---------- */
        JSONObject io = new JSONObject();
        try {
            if (info != null) {
                io.put("repo", info.optString("repo_name", ""));
                io.put("htmlUrl", info.optString("html_url", ""));
                io.put("license", info.optString("license", ""));
                io.put("tagline", info.optString("tagline", ""));
                io.put("preRelease", info.optBoolean("is_pre_release"));
                io.put("obsolete", info.optBoolean("is_obsolete"));
                io.put("state", info.optString("state_name", ""));
                io.put("build", info.optLong("build_number", 0));
                JSONArray cats = info.optJSONArray("categories");
                if (cats != null) {
                    JSONArray out = new JSONArray();
                    for (int i = 0; i < cats.length() && i < 6; i++) {
                        JSONObject c = cats.optJSONObject(i);
                        if (c != null) out.put(c.optString("category_name", ""));
                    }
                    io.put("categories", out);
                }
                JSONArray kw = info.optJSONArray("keywords");
                if (kw != null) {
                    JSONArray out = new JSONArray();
                    for (int i = 0; i < kw.length() && i < 8; i++) out.put(kw.optString(i));
                    io.put("keywords", out);
                }
                JSONObject prod = info.optJSONObject("producers");
                if (prod != null) {
                    JSONArray out = new JSONArray();
                    JSONArray collab = prod.optJSONArray("Collaborator");
                    if (collab != null) for (int i = 0; i < collab.length() && i < 6; i++) out.put(collab.optString(i));
                    io.put("collaborators", out);
                }
            }
        } catch (Throwable ignored) {
        }
        try {
            r.put("info", io);
        } catch (Throwable ignored) {
        }

        /* ---------- README (description) ---------- */
        if (wantReadme && info != null) {
            String repo = info.optString("repo_name", "");
            String readme = null;
            if (!repo.isEmpty() && repo.contains("/")) {
                File mdFile = new File(dir, safeKey(rel) + ".readme");
                try {
                    if (!mdFile.isFile() || System.currentTimeMillis() - mdFile.lastModified() > TTL_README_MS
                            || mdFile.length() < 4) {
                        // README.md is the common name; fallbacks for the rest
                        String[] candidates = {
                                RAW_README + repo + "/HEAD/README.md",
                                RAW_README + repo + "/HEAD/readme.md",
                                RAW_README + repo + "/HEAD/Readme.md",
                                RAW_README + repo + "/HEAD/README.MD",
                        };
                        boolean got = false;
                        for (String u : candidates) {
                            try {
                                Installer.downloadFile(u, mdFile, (Installer.ByteProgressListener) null);
                                got = true;
                                break;
                            } catch (Throwable ignored) {
                                // next candidate
                            }
                        }
                        if (!got && mdFile.isFile()) //noinspection ResultOfMethodCallIgnored
                            mdFile.delete();
                    }
                    if (mdFile.isFile()) readme = readText(mdFile, README_MAX);
                } catch (Throwable ignored) {
                    readme = null;
                }
            }
            try {
                r.put("readme", readme == null || readme.trim().isEmpty() ? null : readme);
            } catch (Throwable ignored) {
            }
        }
        return r;
    }

    private static String readText(File f, int max) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n, total = 0;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                total += n;
                if (total >= max) break;
            }
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static byte[] readBytes(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    /** Tiny magic-byte MIME sniff - icons are png/jpg/gif/webp. */
    private static String mimeOf(byte[] b) {
        if (b == null || b.length < 12) return "image/png";
        if ((b[0] & 0xFF) == 0x89 && b[1] == 'P') return "image/png";
        if ((b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8) return "image/jpeg";
        if (b[0] == 'G' && b[1] == 'I' && b[2] == 'F') return "image/gif";
        if (b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F') return "image/webp";
        return "image/png";
    }
}
