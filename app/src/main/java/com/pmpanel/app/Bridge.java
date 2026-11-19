package com.pmpanel.app;

import android.app.ActivityManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.SocketTimeoutException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** JSON command router exposed to the WebView panel via addJavascriptInterface. */
public class Bridge {

    /* package-private so helper classes (MarketFetch) can push async events */
    final MainActivity act;
    private final ServerManager smDefault;

    public Bridge(MainActivity act) {
        this.act = act;
        this.smDefault = ServerManager.get(act);
    }

    @JavascriptInterface
    public String api(String request) {
        // IMPORTANT: this method is invoked by Chromium's JS bridge. If ANY throwable
        // escapes it, the WebView turns it into the useless generic error
        // "Java exception was raised during method invocation" (e.g. on low-RAM
        // devices where OutOfMemoryError / StackOverflowError are not Exception).
        // So: catch Throwable everywhere and always return a JSON payload.
        String out;
        try {
            JSONObject res;
            try {
                JSONObject req = new JSONObject(request);
                res = handle(req);
            } catch (Throwable t) {
                res = errObj(safeMsg(t));
            }
            try {
                out = res.toString();
            } catch (Throwable t) {
                out = "{\"ok\":false,\"error\":\"response build failed: " + safeMsg(t) + "\"}";
            }
        } catch (Throwable t) {
            // absolute last resort - must never happen
            out = "{\"ok\":false,\"error\":\"internal bridge error\"}";
        }
        return out;
    }

    /** Class name + message, null-safe, JSON-string-safe (also used by other classes). */
    static String safeMsg(Throwable t) {
        String m = (t == null) ? "unknown" : t.getMessage();
        String s = (t == null ? "unknown" : t.getClass().getSimpleName()) + (m == null ? "" : (": " + m));
        return s.replace('"', '\'').replace('\n', ' ').replace('\r', ' ');
    }

    private JSONObject handle(JSONObject req) throws Exception {
        String cmd = req.optString("cmd", "");
        /* v2.4 multi-server: every request may carry a "profile" id; the
         * default keeps working for old callers. */
        final String profileId;
        {
            String p = req.optString("profile", Profiles.DEFAULT_ID);
            profileId = Profiles.validId(p) ? p : Profiles.DEFAULT_ID;
        }
        final ServerManager sm = ServerManager.forProfile(act, profileId);
        switch (cmd) {
            case "ping": {
                JSONObject r = ok();
                r.put("pong", true);
                return r;
            }
            case "bootstrap": {
                try {
                    Installer.ensure(act);
                    return ok();
                } catch (Throwable e) {
                    return err("setup failed: " + safeMsg(e));
                }
            }
            case "info":
                return info(sm);
            case "status":
                return sm.status();
            case "start":
                /* Port conflicts are handled inside start(): a server whose UDP
                 * port a running server already owns is moved to a free port
                 * automatically (and a note is written to its console). */
                return sm.start();
            case "stop":
                sm.stopAsync();
                return ok();
            case "restart":
                sm.restartAsync();
                return ok();
            case "command":
                return sm.sendCommand(req.optString("text", ""));
            case "console":
                return sm.consoleSince(req.optLong("after", 0));

            /* ---------------- multi-server profiles (v2.4) ---------------- */
            case "profiles.list":
                return Profiles.list(act);
            case "profiles.create":
                return Profiles.create(act, req.optString("name"), req.optInt("port", 0));
            case "profiles.rename":
                return Profiles.rename(act, req.optString("profile"), req.optString("name"));
            case "profiles.delete":
                return Profiles.delete(act, req.optString("profile"));

            /* ---------------- config zip importer (v2.4) ---------------- */
            case "zipimport.analyze": {
                final String reqIdZ = req.optString("reqId");
                final String srcZ = req.optString("src");
                new Thread(() -> {
                    JSONObject r = ZipImport.analyze(act, sm.fs, srcZ);
                    act.pushEvent(reqIdZ, r);
                }, "pm-zipimport").start();
                return asyncStarted();
            }
            case "zipimport.apply": {
                if (sm.isRunning()) return err("stop the server first");
                final String reqIdA = req.optString("reqId");
                final String stage = req.optString("stageId");
                new Thread(() -> {
                    JSONObject r = ZipImport.apply(act, sm.fs, stage);
                    act.pushEvent(reqIdA, r);
                }, "pm-zipapply").start();
                return asyncStarted();
            }

            case "files.ls":
                return sm.fs.ls(req.optString("path", ""));
            case "files.read":
                return sm.fs.readText(req.optString("path"), 1536 * 1024);
            case "files.write": {
                sm.fs.writeText(req.optString("path"), req.optString("content"));
                return ok();
            }
            case "files.delete": {
                sm.fs.delete(req.optString("path"));
                return ok();
            }
            case "files.rename": {
                sm.fs.rename(req.optString("path"), req.optString("name"));
                return ok();
            }
            case "files.move": {
                sm.fs.move(req.optString("path"), req.optString("dest"));
                return ok();
            }
            case "files.mkdir": {
                sm.fs.mkdir(req.optString("path"));
                return ok();
            }
            case "files.newfile": {
                sm.fs.writeText(req.optString("path"), "");
                return ok();
            }
            case "files.unzip": {
                int n = sm.fs.unzip(req.optString("path"), req.optString("dest", ""));
                JSONObject r = ok();
                r.put("files", n);
                return r;
            }

            case "props.get": {
                JSONObject r = ok();
                r.put("lines", sm.fs.readProperties("server.properties"));
                return r;
            }
            case "props.set": {
                if (sm.isRunning()) return err("stop the server first");
                sm.fs.writeProperties("server.properties", req.getJSONArray("lines"));
                return ok();
            }

            case "prefs.get": {
                SharedPreferences p = Installer.prefs(act);
                JSONObject r = ok();
                r.put("wakeLock", p.getBoolean("wakeLock", true));
                r.put("keepScreenOn", p.getBoolean("keepScreenOn", false));
                /* v2.5: the memory limit belongs to the SERVER the call is
                 * aimed at, so two servers can have different limits. */
                r.put("memoryLimitMb", Installer.getMemoryLimitMb(act, profileId));
                r.put("profile", profileId);
                r.put("profileName", Profiles.nameOf(act, profileId));
                return r;
            }
            case "prefs.set": {
                SharedPreferences.Editor ed = Installer.prefs(act).edit();
                if (req.has("wakeLock")) ed.putBoolean("wakeLock", req.getBoolean("wakeLock"));
                if (req.has("keepScreenOn")) ed.putBoolean("keepScreenOn", req.getBoolean("keepScreenOn"));
                ed.apply();
                if (req.has("memoryLimitMb")) {
                    int mb = Math.max(128, Math.min(4096, req.optInt("memoryLimitMb", 1024)));
                    /* applies ONLY to the server whose settings page is open */
                    Installer.setMemoryLimit(act, profileId, mb);
                }
                act.applyKeepScreenOn();
                return ok();
            }

            case "logs.list":
                return sm.fs.listLogs();
            case "logs.read": {
                String name = req.optString("name");
                JSONObject r = ok();
                r.put("name", name);
                r.put("content", sm.fs.tailText("logs/" + name, 512 * 1024));
                return r;
            }
            case "logs.delete": {
                sm.fs.deleteLog(req.optString("name"));
                return ok();
            }
            case "logs.clear": {
                sm.fs.clearLogs();
                return ok();
            }

            case "backup.create":
                return backupCreate(req, sm);
            case "backup.restore":
                act.pickRestore(req.optString("reqId"), profileId);
                return asyncStarted();
            case "backup.list": {
                File dir = Installer.backupsDir(sm.fs.getRoot());
                JSONArray arr = new JSONArray();
                File[] files = dir.listFiles();
                if (files != null) {
                    java.util.Arrays.sort(files, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
                    for (File f : files) {
                        if (!f.isFile()) continue;
                        JSONObject o = new JSONObject();
                        o.put("name", f.getName());
                        o.put("size", f.length());
                        o.put("mtime", f.lastModified());
                        arr.put(o);
                    }
                }
                JSONObject r = ok();
                r.put("entries", arr);
                return r;
            }
            case "backup.save": {
                String name = req.optString("name");
                act.pickSave(req.optString("reqId"), "backups/" + name, name, profileId);
                return asyncStarted();
            }

            case "upload.pick":
                act.pickUpload(req.optString("reqId"), req.optString("dir", ""),
                        req.optBoolean("multiple", true), profileId);
                return asyncStarted();

            case "download.save":
                act.pickSave(req.optString("reqId"), req.optString("path"), req.optString("suggested"), profileId);
                return asyncStarted();

            case "update.check":
                return updateCheck(req);
            case "update.download":
                return updateDownload(req, sm);
            case "phar.apply": {
                if (sm.isRunning()) return err("stop the server first");
                String path = req.optString("path");
                if (!path.toLowerCase(Locale.US).endsWith(".phar")) return err("not a phar file");
                File f = sm.fs.resolve(path);
                if (!f.isFile() || f.length() < 300 * 1024) return err("phar file too small or missing");
                Installer.applyPhar(act, sm.fs.getRoot(), f);
                return ok();
            }

            case "storageInfo":
                return storageInfo(sm);

            case "plugins.list":
                return pluginsList(sm);
            case "worlds.list":
                return worldsList(sm);
            case "packs.list":
                return packsList(sm);

            case "plugins.enable":
            case "plugins.disable":
                return pluginToggle(req, cmd.equals("plugins.disable"), sm);

            case "tool.compile": {
                /* pure-Java phar writer (Phar.java) - no PHP process involved,
                 * works on every device and is safe while the server runs:
                 * it only reads the source folder and writes compiled/<name>.phar. */
                final String reqIdC = req.optString("reqId");
                final String srcC = req.optString("src");
                final String nameC = req.optString("name");
                new Thread(() -> {
                    JSONObject r = PluginTools.compile(act, sm.fs, srcC, nameC);
                    act.pushEvent(reqIdC, r);
                }, "pm-compile").start();
                return asyncStarted();
            }
            case "tool.decompile": {
                /* read-only extraction into src/<name>/ - safe while running */
                final String reqIdD = req.optString("reqId");
                final String srcD = req.optString("src");
                new Thread(() -> {
                    JSONObject r = PluginTools.decompile(act, sm.fs, srcD);
                    act.pushEvent(reqIdD, r);
                }, "pm-decompile").start();
                return asyncStarted();
            }

            /* generic file downloader (Tools > Server package download) */
            case "dl.download": {
                final String reqIdDL = req.optString("reqId");
                final String urlDL = req.optString("url", "").trim();
                final String nameDL = req.optString("name", "").trim();
                if (urlDL.isEmpty()) return err("url is empty");
                if (!urlDL.startsWith("https://") && !urlDL.startsWith("http://")) {
                    return err("url must start with http:// or https://");
                }
                new Thread(() -> {
                    JSONObject r;
                    try {
                        File dir = new File(sm.fs.getRoot(), "downloads");
                        //noinspection ResultOfMethodCallIgnored
                        dir.mkdirs();
                        String name = !nameDL.isEmpty() ? nameDL : nameFromUrl(urlDL);
                        name = name.replaceAll("[^A-Za-z0-9._()\\-]", "_");
                        if (name.isEmpty() || name.startsWith(".")) name = "download-" + System.currentTimeMillis();
                        File dest = new File(dir, name);
                        int n = 2;
                        while (dest.exists()) {
                            int dot = name.lastIndexOf('.');
                            String base = dot > 0 ? name.substring(0, dot) : name;
                            String ext = dot > 0 ? name.substring(dot) : "";
                            dest = new File(dir, base + "_" + n++ + ext);
                        }
                        final File outF = dest;
                        Installer.downloadFile(urlDL, outF, (done, total) -> {
                            int pct = total > 0 ? (int) Math.min(100, done * 100 / total) : -1;
                            JSONObject ev = ServerManager.JO("ok", true,
                                    "progress", pct, "done", done, "total", total);
                            act.pushEvent(reqIdDL, ev);
                        });
                        if (!outF.isFile() || outF.length() == 0) throw new IOException("empty download");
                        r = ServerManager.JO("ok", true,
                                "file", relPath(sm, outF),
                                "name", outF.getName(),
                                "size", outF.length());
                    } catch (Throwable t) {
                        r = errObj(safeMsg(t));
                    }
                    act.pushEvent(reqIdDL, r);
                }, "pm-dl").start();
                return asyncStarted();
            }

            case "bot.status": {
                JSONObject r = ok();
                r.put("engine", BotEngine.available(act));
                r.put("running", BotEngine.running());
                return r;
            }
            case "bot.start":
                return BotEngine.start(act);
            case "bot.cmd": {
                final String line = req.optString("line", "");
                if (line.isEmpty()) return err("empty bot command");
                return BotEngine.send(line);
            }
            case "bot.stop":
                return BotEngine.stop();

            /* ---------------- pack fetcher (v2.6) ----------------
             * Joins a PUBLIC Bedrock server with the real protocol engine
             * (libpmbot.so) and saves the resource packs it pushes onto its
             * players into <server>/downloads as .mcpack files. Progress and
             * results come back as bot events (ev=packs), not as a reply.
             * v2.7: useAuth - servers with xbox-auth=on reject offline
             * clients ("notAuthenticated"); when the user has signed in,
             * the fetch joins with the real account. */
            case "packs.fetch": {
                final String addrP = req.optString("addr", "").trim();
                if (addrP.isEmpty()) return err("server address is empty");
                if (!BotEngine.available(act)) return err("bot engine binary is missing on this device");
                if (!BotEngine.running()) {
                    JSONObject st = BotEngine.start(act);
                    if (!st.optBoolean("ok", false)) return st;
                    if (!BotEngine.running()) return err("failed to start bot engine");
                }
                File dir = new File(sm.fs.getRoot(), "downloads");
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                JSONObject op = new JSONObject();
                op.put("op", "getpacks");
                op.put("addr", addrP);
                op.put("dest", dir.getAbsolutePath());
                op.put("useAuth", req.optBoolean("useAuth", false));
                return BotEngine.send(op.toString());
            }
            case "packs.stop":
                return BotEngine.send("{\"op\":\"packs_stop\"}");

            /* ---------------- v2.7: live statistics ---------------- */
            case "stats.get": {
                JSONObject r = statsGet(sm);
                return r;
            }
            case "stats.storage":
                return statsStorage(sm);

            /* ---------------- v2.7: Poggit plugin market ---------------- */
            case "market.meta": {
                try {
                    MarketIndex.load(act);
                } catch (Throwable t) {
                    return err("plugin index missing: " + safeMsg(t));
                }
                JSONObject r = ok();
                r.put("meta", MarketIndex.meta());
                return r;
            }
            case "market.search": {
                try {
                    MarketIndex.load(act);
                } catch (Throwable t) {
                    return err("plugin index missing: " + safeMsg(t));
                }
                String q = req.optString("q", "").trim();
                String sort = req.optString("sort", "downloads");
                int limit = Math.max(10, Math.min(60, req.optInt("limit", 40)));
                java.util.List<org.json.JSONObject> hits = MarketIndex.search(q, sort, limit);
                JSONArray arr = new JSONArray();
                for (org.json.JSONObject p : hits) arr.put(p);
                JSONObject r = ok();
                r.put("results", arr);
                return r;
            }
            case "market.install": {
                if (sm.isRunning()) return err("stop the server first (plugins load at boot)");
                final String reqIdM = req.optString("reqId");
                final String pathM = req.optString("path");
                final String nameM = req.optString("name");
                final String verM = req.optString("version", "");
                if (pathM.isEmpty() || !pathM.endsWith(".phar") || pathM.contains("..")) {
                    return err("bad plugin path");
                }
                new Thread(() -> {
                    JSONObject r;
                    try {
                        String safe = nameM.replaceAll("[^A-Za-z0-9._()\\-]", "_");
                        if (safe.isEmpty()) safe = "plugin";
                        String fname = verM.isEmpty() ? safe + ".phar"
                                : safe + "_" + verM.replaceAll("[^A-Za-z0-9._()\\-]", "_") + ".phar";
                        File dest = new File(new File(sm.fs.getRoot(), "plugins"), fname);
                        //noinspection ResultOfMethodCallIgnored
                        dest.getParentFile().mkdirs();
                        Installer.downloadFile(MarketIndex.BASE_URL + pathM, dest, (done, total) -> {
                            int pct = total > 0 ? (int) Math.min(100, done * 100 / total) : -1;
                            act.pushEvent(reqIdM, ServerManager.JO("ok", true,
                                    "progress", pct, "done", done, "total", total));
                        });
                        if (!dest.isFile() || dest.length() < 200) throw new IOException("downloaded phar is empty");
                        r = ServerManager.JO("ok", true,
                                "file", "plugins/" + dest.getName(),
                                "name", dest.getName(),
                                "size", dest.length());
                    } catch (Throwable t) {
                        r = errObj(safeMsg(t));
                    }
                    act.pushEvent(reqIdM, r);
                }, "pm-market-install").start();
                return asyncStarted();
            }
            /* ---------------- v2.8: plugin images + descriptions ----------------
             * Fetches/caches the release info.json (icon URL, GitHub repo,
             * categories...), the plugin icon image and optionally its README
             * (the description shown when a plugin is tapped). */
            case "market.fetch": {
                final String reqIdMF = req.optString("reqId");
                final String nameMF = req.optString("name");
                final String phMF = req.optString("ph");
                if (phMF.isEmpty() || phMF.startsWith("/") || phMF.contains("..")) return err("bad plugin path");
                final boolean readmeMF = req.optBoolean("readme", false);
                MarketFetch.fetch(this, reqIdMF, nameMF, phMF, readmeMF);
                return asyncStarted();
            }
            /* ---------------- v2.7: connectivity self-test ---------------- */
            case "net.check": {
                final String reqIdN = req.optString("reqId");
                new Thread(() -> {
                    JSONObject r;
                    try {
                        r = NetCheck.run();
                    } catch (Throwable t) {
                        r = errObj(safeMsg(t));
                    }
                    act.pushEvent(reqIdN, r);
                }, "pm-netcheck").start();
                return asyncStarted();
            }

            case "pubip.upnp": {
                final String reqIdU = req.optString("reqId");
                final int portU = Math.max(1, Math.min(65535, req.optInt("port", 19132)));
                new Thread(() -> {
                    JSONObject r;
                    try {
                        String localIp = PublicIpInfo.getLocalIp();
                        r = UpnpPortMapper.mapPort(portU, localIp);
                    } catch (Throwable t) {
                        r = errObj(safeMsg(t));
                    }
                    act.pushEvent(reqIdU, r);
                }, "pm-upnp").start();
                return asyncStarted();
            }

            case "pubip.info": {
                final String reqIdP = req.optString("reqId");
                final boolean runningP = sm.isRunning();
                final int portP = PublicIpInfo.serverPort(sm);
                new Thread(() -> {
                    try {
                        JSONObject r = ok();
                        r.put("publicIp", PublicIpInfo.fetchPublicIp());
                        r.put("localIp", PublicIpInfo.getLocalIp());
                        r.put("port", portP);
                        r.put("running", runningP);
                        act.pushEvent(reqIdP, r);
                    } catch (Throwable t) {
                        act.pushEvent(reqIdP, errObj(safeMsg(t)));
                    }
                }, "pm-pubip").start();
                return asyncStarted();
            }
            case "pubip.ping": {
                final String reqIdQ = req.optString("reqId");
                final String hostQ = req.optString("host");
                final int portQ = Math.max(1, Math.min(65535, req.optInt("port", 19132)));
                new Thread(() -> {
                    JSONObject r;
                    try {
                        r = RakNetPing.ping(hostQ, portQ, 6000);
                        r.put("ok", true);
                    } catch (SocketTimeoutException | java.net.ConnectException | java.net.UnknownHostException e) {
                        r = errObj("no response from " + hostQ + ":" + portQ + " (port closed or unreachable)");
                    } catch (Throwable t) {
                        r = errObj(safeMsg(t));
                    }
                    act.pushEvent(reqIdQ, r);
                }, "pm-rakping").start();
                return asyncStarted();
            }

            case "rcon.exec": {
                final String reqIdR = req.optString("reqId");
                final String hostR = req.optString("host").trim();
                final int portR = Math.max(1, Math.min(65535, req.optInt("port", 19132)));
                final String passR = req.optString("password");
                final String cmdR = req.optString("cmd");
                if (hostR.isEmpty()) return err("remote host is empty");
                new Thread(() -> {
                    JSONObject r;
                    try {
                        String resp = RconClient.exec(hostR, portR, passR, cmdR, 8000);
                        r = ServerManager.JO("ok", true, "response", resp == null ? "" : resp);
                    } catch (java.net.SocketTimeoutException e) {
                        r = errObj("rcon timeout - is the server online and is rcon enabled?");
                    } catch (java.net.ConnectException e) {
                        r = errObj("cannot connect to " + hostR + ":" + portR);
                    } catch (Throwable t) {
                        r = errObj(safeMsg(t));
                    }
                    act.pushEvent(reqIdR, r);
                }, "pm-rcon").start();
                return asyncStarted();
            }

            case "batteryOpt":
                act.runOnUiThread(act::requestIgnoreBatteryOptimizations);
                return ok();
            case "openUrl": {
                String url = req.optString("url");
                if (!url.startsWith("https://")) return err("https only");
                act.runOnUiThread(() -> {
                    try {
                        act.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                    }
                });
                return ok();
            }
            default: {
                JSONObject r = err("unknown command: " + cmd);
                return r;
            }
        }
    }

    // ---------------- info ----------------

    private JSONObject info(ServerManager sm) throws Exception {
        JSONObject r = ok();
        String ver;
        try {
            ver = act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionName;
        } catch (Throwable t) {
            ver = "?";
        }
        r.put("appVersion", ver);
        r.put("bundle", Installer.bundleInfo(act));
        File phar = new File(sm.fs.getRoot(), "PocketMine-MP.phar");
        JSONObject ph = new JSONObject();
        ph.put("exists", phar.isFile());
        ph.put("size", phar.length());
        ph.put("mtime", phar.lastModified());
        File bak = new File(sm.fs.getRoot(), "PocketMine-MP.phar.bak");
        ph.put("backupExists", bak.isFile());
        r.put("phar", ph);
        JSONObject dev = new JSONObject();
        dev.put("model", Build.MODEL);
        dev.put("manufacturer", Build.MANUFACTURER);
        dev.put("android", Build.VERSION.RELEASE);
        dev.put("sdk", Build.VERSION.SDK_INT);
        dev.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
        try {
            ActivityManager am = (ActivityManager) act.getSystemService(MainActivity.ACTIVITY_SERVICE);
            if (am != null) {
                ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
                am.getMemoryInfo(mi);
                dev.put("totalRam", mi.totalMem);
            } else {
                dev.put("totalRam", 0);
            }
        } catch (Throwable ignored) {
            dev.put("totalRam", 0);
        }
        r.put("device", dev);
        r.put("serverDir", sm.fs.getRoot().getAbsolutePath());
        r.put("profile", sm.profileId);
        r.put("profileName", sm.profileName());
        try {
            File php = sm.resolvePhp();
            r.put("phpBinaryOk", php != null && php.canExecute());
        } catch (Throwable t) {
            r.put("phpBinaryOk", false);
        }
        return r;
    }

    private JSONObject storageInfo(ServerManager sm) throws org.json.JSONException {
        File root = sm.fs.getRoot();
        JSONObject r = ok();
        JSONObject sizes = new JSONObject();
        String[] parts = {"worlds", "plugins", "plugin_data", "players", "resource_packs", "logs", "backups", "crashdumps"};
        for (String p : parts) {
            File f = new File(root, p);
            if (f.exists()) sizes.put(p, sm.fs.dirSize(f));
        }
        r.put("sizes", sizes);
        r.put("total", sm.fs.dirSize(root));
        r.put("free", root.getFreeSpace());
        r.put("cache", sm.fs.dirSize(Installer.cacheTmp(act)));
        return r;
    }

    // ---------------- plugin enable/disable (fast move) ----------------

    private JSONObject pluginToggle(JSONObject req, boolean disable, ServerManager sm) {
        try {
            if (sm.isRunning()) return err("stop the server first");
            String path = req.optString("path");
            if (path.isEmpty()) return err("plugin path is empty");
            File src = sm.fs.resolve(path);
            String norm = path.replace('\\', '/');
            String name = norm.substring(norm.lastIndexOf('/') + 1);
            if (name.isEmpty() || name.equals(".") || name.equals("..")) return err("bad plugin path");
            File destDir = new File(sm.fs.getRoot(), disable ? "plugins_disabled" : "plugins");
            //noinspection ResultOfMethodCallIgnored
            destDir.mkdirs();
            File dest = new File(destDir, name);
            if (!src.isFile() && !src.isDirectory()) return err("plugin not found: " + path);
            if (dest.exists()) return err(disable ? "a plugin with this name is already disabled" : "a plugin with this name is already enabled");
            if (!src.renameTo(dest)) {
                // cross-directory rename should work inside the same data dir; fall back to copy+delete
                java.io.InputStream in = new java.io.FileInputStream(src);
                java.io.OutputStream out = new java.io.FileOutputStream(dest);
                byte[] buf = new byte[65536];
                int r;
                while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
                in.close();
                out.flush();
                out.close();
                deleteRecursive(src);
            }
            return ok();
        } catch (Throwable t) {
            return errObj(safeMsg(t));
        }
    }

    private static void deleteRecursive(File f) throws IOException {
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteRecursive(k);
        }
        if (!f.delete()) throw new IOException("cannot delete " + f.getName());
    }

    // ---------------- content lists (plugins / worlds / packs) ----------------

    private JSONObject pluginsList(ServerManager sm) throws org.json.JSONException {
        File root = sm.fs.getRoot();
        JSONArray arr = new JSONArray();
        collectPlugins(sm, new File(root, "plugins"), true, arr);
        collectPlugins(sm, new File(root, "plugins_disabled"), false, arr);
        JSONObject r = ok();
        r.put("plugins", arr);
        return r;
    }

    private void collectPlugins(ServerManager sm, File dir, boolean enabled, JSONArray out) {
        File[] files = dir.listFiles();
        if (files == null) return;
        java.util.Arrays.sort(files, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
        for (File f : files) {
            String lower = f.getName().toLowerCase(Locale.US);
            boolean candidate = f.isDirectory()
                    ? new File(f, "plugin.yml").isFile()
                    : lower.endsWith(".phar") || lower.endsWith(".zip");
            if (!candidate) continue;
            JSONObject o = PharMeta.pluginMeta(f);
            try {
                // A folder with src/ is an uncompiled (source) plugin: PocketMine does not
                // load these by itself - users install DevTools for that. Surface the fact
                // so the panel can flag it and offer one-tap compilation to a real phar.
                boolean source = f.isDirectory() && new File(f, "src").isDirectory();
                o.put("file", (enabled ? "plugins/" : "plugins_disabled/") + f.getName());
                o.put("format", source ? "source" : (f.isDirectory() ? "dir" : (lower.endsWith(".phar") ? "phar" : "zip")));
                o.put("enabled", enabled);
                o.put("size", f.isDirectory() ? sm.fs.dirSize(f) : f.length());
                o.put("mtime", f.lastModified());
                if (!o.has("name")) o.put("name", f.getName().replaceAll("\\.(phar|zip)$", ""));
            } catch (Exception ignored) {
            }
            out.put(o);
        }
    }

    private JSONObject worldsList(ServerManager sm) throws org.json.JSONException {
        File root = sm.fs.getRoot();
        JSONArray arr = new JSONArray();
        String def = "";
        try {
            JSONArray propLines = sm.fs.readProperties("server.properties");
            for (int i = 0; i < propLines.length(); i++) {
                JSONObject line = propLines.optJSONObject(i);
                if (line != null && "level-name".equals(line.optString("key"))) def = line.optString("value");
            }
        } catch (Exception ignored) {
        }
        File dir = new File(root, "worlds");
        File[] files = dir.listFiles();
        if (files != null) {
            java.util.Arrays.sort(files, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
            for (File f : files) {
                if (!f.isDirectory() || !new File(f, "level.dat").isFile()) continue;
                JSONObject o = new JSONObject();
                try {
                    o.put("folder", "worlds/" + f.getName());
                    o.put("name", f.getName());
                    o.put("levelName", PharMeta.worldName(f));
                    o.put("size", sm.fs.dirSize(f));
                    o.put("mtime", f.lastModified());
                    o.put("isDefault", f.getName().equals(def));
                } catch (Exception ignored) {
                }
                arr.put(o);
            }
        }
        JSONObject r = ok();
        r.put("worlds", arr);
        r.put("default", def);
        return r;
    }

    private JSONObject packsList(ServerManager sm) throws org.json.JSONException {
        File root = sm.fs.getRoot();
        JSONArray arr = new JSONArray();
        File dir = new File(root, "resource_packs");
        File[] files = dir.listFiles();
        if (files != null) {
            java.util.Arrays.sort(files, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
            for (File f : files) {
                String lower = f.getName().toLowerCase(Locale.US);
                boolean candidate = f.isDirectory()
                        || lower.endsWith(".mcpack") || lower.endsWith(".zip");
                if (!candidate) continue;
                JSONObject o = PharMeta.packMeta(f);
                try {
                    o.put("file", "resource_packs/" + f.getName());
                    o.put("format", f.isDirectory() ? "dir" : "zip");
                    o.put("size", f.isDirectory() ? sm.fs.dirSize(f) : f.length());
                    o.put("mtime", f.lastModified());
                    if (!o.has("name")) o.put("name", f.getName().replaceAll("\\.(mcpack|zip)$", ""));
                } catch (Exception ignored) {
                }
                arr.put(o);
            }
        }
        JSONObject r = ok();
        r.put("packs", arr);
        return r;
    }

    // ---------------- v2.7: statistics ----------------

    /** Live lightweight stats: process + console-derived numbers + a GameSpy
     *  query against 127.0.0.1:<port> for the REAL online player list. */
    private JSONObject statsGet(ServerManager sm) throws Exception {
        JSONObject st = sm.status();
        try {
            JSONObject props = new JSONObject();
            try {
                JSONArray lines = sm.fs.readProperties("server.properties");
                for (int i = 0; i < lines.length(); i++) {
                    JSONObject l = lines.optJSONObject(i);
                    if (l != null && "k".equals(l.optString("type"))) {
                        props.put(l.optString("key"), l.optString("value"));
                    }
                }
            } catch (Throwable ignored) {
            }
            st.put("props", props);
            int port = Profiles.readPort(sm.fs.getRoot());
            st.put("port", port);
            if ("running".equals(st.optString("state")) && port > 0) {
                try {
                    JSONObject q = QueryClient.query("127.0.0.1", port, 1800);
                    st.put("query", q);
                    JSONArray qn = q.optJSONArray("players");
                    if (qn != null && qn.length() > 0) {
                        st.put("playersOnline", qn);
                        st.put("playersCount", qn.length());
                    }
                    if (q.optInt("maxplayers", 0) > 0) st.put("playersMax", q.optInt("maxplayers"));
                } catch (Throwable qe) {
                    st.put("queryError", Bridge.safeMsg(qe));
                }
            }
        } catch (Throwable ignored) {
        }
        return st;
    }

    /** Heavy part: directory sizes + content counts (plugins/worlds/packs). */
    private JSONObject statsStorage(ServerManager sm) throws org.json.JSONException {
        File root = sm.fs.getRoot();
        JSONObject r = ok();
        JSONObject sizes = new JSONObject();
        String[] parts = {"worlds", "plugins", "plugins_disabled", "plugin_data", "players",
                "resource_packs", "logs", "backups", "downloads", "crashdumps"};
        for (String p : parts) {
            File f = new File(root, p);
            if (f.exists()) sizes.put(p, sm.fs.dirSize(f));
        }
        r.put("sizes", sizes);
        r.put("total", sm.fs.dirSize(root));
        r.put("free", root.getFreeSpace());
        r.put("cache", sm.fs.dirSize(Installer.cacheTmp(act)));
        JSONArray plugins = new JSONArray();
        collectPlugins(sm, new File(root, "plugins"), true, plugins);
        JSONArray worlds = new JSONArray();
        collectWorlds(sm, worlds);
        JSONArray packs = new JSONArray();
        collectPacks(sm, packs);
        r.put("pluginCount", plugins.length());
        r.put("worldCount", worlds.length());
        r.put("packCount", packs.length());
        long totalWorlds = 0, totalPlayers = 0;
        File pl = new File(root, "players");
        File[] pf = pl.listFiles();
        if (pf != null) for (File f : pf) totalPlayers++;
        r.put("playerFiles", totalPlayers);
        JSONObject topWorlds = new JSONObject();
        File wd = new File(root, "worlds");
        File[] wfs = wd.listFiles();
        if (wfs != null) {
            java.util.Arrays.sort(wfs, (a, b) -> Long.compare(sm.fs.dirSize(b), sm.fs.dirSize(a)));
            for (int i = 0; i < Math.min(5, wfs.length); i++) {
                if (wfs[i].isDirectory()) topWorlds.put(wfs[i].getName(), sm.fs.dirSize(wfs[i]));
            }
        }
        try {
            r.put("topWorlds", topWorlds);
        } catch (Throwable ignored) {
        }
        return r;
    }

    private void collectWorlds(ServerManager sm, JSONArray out) throws org.json.JSONException {
        File dir = new File(sm.fs.getRoot(), "worlds");
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (!f.isDirectory() || !new File(f, "level.dat").isFile()) continue;
            JSONObject o = new JSONObject();
            o.put("name", f.getName());
            o.put("size", sm.fs.dirSize(f));
            out.put(o);
        }
    }

    private void collectPacks(ServerManager sm, JSONArray out) throws org.json.JSONException {
        File dir = new File(sm.fs.getRoot(), "resource_packs");
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            String lower = f.getName().toLowerCase(Locale.US);
            if (!f.isDirectory() && !lower.endsWith(".mcpack") && !lower.endsWith(".zip")) continue;
            JSONObject o = new JSONObject();
            o.put("name", f.getName());
            o.put("size", f.isDirectory() ? sm.fs.dirSize(f) : f.length());
            out.put(o);
        }
    }

    // ---------------- async ops ----------------

    private JSONObject asyncStarted() {
        return ServerManager.JO("ok", true, "async", true);
    }

    private JSONObject backupCreate(JSONObject req, ServerManager sm) {
        final String reqId = req.optString("reqId");
        new Thread(() -> {
            JSONObject r;
            try {
                File dir = Installer.backupsDir(sm.fs.getRoot());
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                String stamp = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(new Date());
                File out = new File(dir, "backup-" + stamp + ".zip");
                long size = sm.fs.createBackup(out);
                r = ServerManager.JO("ok", true, "name", out.getName(), "size", size);
            } catch (Throwable t) {
                r = errObj(safeMsg(t));
            }
            act.pushEvent(reqId, r);
        }, "pm-backup").start();
        return asyncStarted();
    }

    /** Called by MainActivity after the user picked a backup zip via SAF. */
    void restoreFromUri(Uri uri, String reqId, String profileId) {
        final ServerManager sm = ServerManager.forProfile(act, profileId);
        new Thread(() -> {
            JSONObject r;
            try {
                File dir = Installer.backupsDir(sm.fs.getRoot());
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File tmp = new File(dir, "incoming-restore.zip");
                try (InputStream in = act.getContentResolver().openInputStream(uri);
                     OutputStream out = new FileOutputStream(tmp)) {
                    copy(in, out);
                }
                // safety backup before restore
                try {
                    String stamp = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(new Date());
                    File pre = new File(dir, "pre-restore-" + stamp + ".zip");
                    sm.fs.createBackup(pre);
                } catch (Exception ignored) {
                }
                int count = sm.fs.restoreBackup(tmp);
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
                r = ServerManager.JO("ok", true, "files", count);
            } catch (Throwable t) {
                r = errObj(safeMsg(t));
            }
            act.pushEvent(reqId, r);
        }, "pm-restore").start();
    }

    private JSONObject updateCheck(JSONObject req) {
        final String reqId = req.optString("reqId");
        new Thread(() -> {
            JSONObject r = Installer.checkUpdates(act);
            act.pushEvent(reqId, r);
        }, "pm-update-check").start();
        return asyncStarted();
    }

    private JSONObject updateDownload(JSONObject req, ServerManager sm) {
        if (sm.isRunning()) return err("stop the server first");
        final String reqId = req.optString("reqId");
        final String url = req.optString("url");
        final String flavor = req.optString("flavor", "custom");
        if (url.isEmpty() || !url.startsWith("https://")) return err("bad url");
        final File dir = sm.fs.getRoot();
        new Thread(() -> {
            JSONObject r;
            try {
                File dest = new File(dir, "incoming-update.phar");
                Installer.downloadFile(url, dest, percent ->
                        act.pushEvent(reqId, progressObj(percent)));
                Installer.applyPhar(act, dir, dest);
                File phar = new File(dir, "PocketMine-MP.phar");
                r = ServerManager.JO("ok", true, "flavor", flavor, "size", phar.length());
            } catch (Throwable t) {
                r = errObj(safeMsg(t));
            }
            act.pushEvent(reqId, r);
        }, "pm-update-download").start();
        return asyncStarted();
    }

    private JSONObject progressObj(int percent) {
        return ServerManager.JO("ok", true, "progress", percent);
    }

    /** File name from a URL path (query stripped), e.g. .../PocketMine-MP.phar?x=1 -> PocketMine-MP.phar */
    private static String nameFromUrl(String url) {
        String s = url;
        int q = s.indexOf('?');
        if (q >= 0) s = s.substring(0, q);
        int slash = s.lastIndexOf('/');
        if (slash >= 0) s = s.substring(slash + 1);
        if (s.length() > 120) s = s.substring(s.length() - 120);
        return s;
    }

    /** Sandbox-relative path of a File inside the server dir. */
    private static String relPath(ServerManager sm, File f) {
        try {
            String root = sm.fs.getRoot().getCanonicalPath();
            String p = f.getCanonicalPath();
            if (p.startsWith(root + File.separator)) {
                return p.substring(root.length() + 1).replace(File.separatorChar, '/');
            }
        } catch (Exception ignored) {
        }
        return f.getName();
    }

    static JSONObject errObj(String msg) {
        return ServerManager.JO("ok", false, "error", msg);
    }

    private JSONObject ok() {
        return ServerManager.JO("ok", true);
    }

    private JSONObject err(String msg) {
        return errObj(msg);
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[65536];
        int r;
        while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
    }
}
