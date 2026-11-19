package com.pmpanel.app;

import android.content.Context;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Manages the PocketMine PHP process lifecycle and console I/O.
 *
 * v2.4: one instance per server PROFILE. The UI picks the profile (a
 * "profile" field on every bridge call); several servers can run at the same
 * time, each with its own process, console buffer and log files. The default
 * profile keeps the legacy single-server directory.
 */
public class ServerManager {

    public static final int STATE_IDLE = 0;
    public static final int STATE_STARTING = 1;
    public static final int STATE_RUNNING = 2;
    public static final int STATE_STOPPING = 3;
    public static final int STATE_STOPPED = 4;
    public static final int STATE_CRASHED = 5;

    private static final int MAX_CONSOLE_LINES = 6000;
    private static final int KEEP_LOGS = 8;

    private static final Map<String, ServerManager> instances = new HashMap<>();

    /** The legacy single-server manager (default profile). */
    public static ServerManager get(Context ctx) {
        return forProfile(ctx, Profiles.DEFAULT_ID);
    }

    /** Manager for a profile id (created on first use, cached afterwards). */
    public static ServerManager forProfile(Context ctx, String profileId) {
        String id = Profiles.validId(profileId) ? profileId : Profiles.DEFAULT_ID;
        synchronized (instances) {
            ServerManager m = instances.get(id);
            if (m == null) {
                m = new ServerManager(ctx.getApplicationContext(), id);
                instances.put(id, m);
            }
            return m;
        }
    }

    /** Existing manager or null (no side effects - safe for status lists). */
    public static ServerManager peek(Context ctx, String profileId) {
        synchronized (instances) {
            return instances.get(profileId);
        }
    }

    /** True when at least one profile's process is alive (keeps the foreground service up). */
    public static boolean anyRunning() {
        synchronized (instances) {
            for (ServerManager m : instances.values()) {
                if (m.isRunning()) return true;
            }
        }
        return false;
    }

    public static void stopAll() {
        synchronized (instances) {
            for (ServerManager m : instances.values()) m.stopAsync();
        }
    }

    private final Context ctx;
    public final String profileId;
    public final Fs fs;
    private final File serverDir;
    private final File tmpDir;

    private volatile Process process;
    private volatile BufferedWriter stdin;
    private volatile int state = STATE_IDLE;
    private volatile int exitCode = 0;
    private volatile long startedAt = 0;
    private volatile String lastError = null;
    private volatile boolean wantStop = false;
    private final AtomicBoolean reaped = new AtomicBoolean(false);

    private final Object consoleLock = new Object();
    private final ArrayDeque<String> consoleLines = new ArrayDeque<>();
    private long seq = 0;
    private int consoleSession = 0;

    /* ---- v2.7 statistics: parsed from the console stream ---- */
    /** ANSI-stripped live set of players currently on this server (join/leave msgs). */
    private final java.util.LinkedHashSet<String> onlinePlayers = new java.util.LinkedHashSet<>();
    private volatile double tpsCurrent = -1, tpsAverage = -1, tickLoad = -1;
    private volatile double netUpKbps = -1, netDownKbps = -1;
    private volatile long tpsAt = 0;
    private volatile String lastStatusBlock = "";
    private volatile long lastStatusAt = 0;
    private volatile int lastListNum = -1, lastListMax = -1;
    private boolean statusCollecting = false;
    private int statusCollected = 0;
    private final StringBuilder statusBuf = new StringBuilder();
    /* CPU% sampling from /proc/<pid>/stat */
    private long lastCpuTicks = -1;
    private long lastCpuAt = 0;
    private volatile double cpuPercent = -1;

    private volatile BufferedWriter logWriter;
    private volatile File currentLogFile;

    private ServerManager(Context ctx, String profileId) {
        this.ctx = ctx;
        this.profileId = profileId;
        this.serverDir = Profiles.dirOf(ctx, profileId);
        this.fs = new Fs(serverDir);
        this.tmpDir = Installer.cacheTmp(ctx);
    }

    public String profileName() {
        return Profiles.nameOf(ctx, profileId);
    }

    public boolean isRunning() {
        Process p = process;
        return p != null && p.isAlive();
    }

    public long uptimeSec() {
        return (state == STATE_STARTING || state == STATE_RUNNING || state == STATE_STOPPING) && startedAt > 0
                ? (System.currentTimeMillis() - startedAt) / 1000 : 0;
    }

    private static boolean hasAbi(String abi) {
        for (String a : Build.SUPPORTED_ABIS) {
            if (abi.equals(a)) return true;
        }
        return false;
    }

    /**
     * Locate an executable 64-bit PHP for this device (shared by all profiles).
     * - Normal case: the packaging system extracts libpmphp.so for the device ABI
     *   into nativeLibraryDir (arm64-v8a / x86_64).
     * - Fallback: on devices whose primary ABI is 32-bit but whose CPU is actually
     *   64-bit capable, the system does NOT extract the arm64 lib. Below Android 10
     *   we may still extract the bundled 64-bit PHP from assets ourselves and exec it
     *   (PocketMine-MP 5 requires 64-bit PHP, so a 32-bit PHP build is useless).
     * Android 10+ blocks exec() from app-private dirs (targetSdk 29+), so there the
     *   fallback is impossible and we report a clear error instead.
     */
    public File resolvePhp() {
        File lib = new File(ctx.getApplicationInfo().nativeLibraryDir, "libpmphp.so");
        if (lib.isFile() && lib.canExecute()) return lib;

        if (Build.VERSION.SDK_INT < 29 && hasAbi("arm64-v8a")) {
            File dir = new File(ctx.getFilesDir(), "php64");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File out = new File(dir, "libpmphp.so");
            if (!out.isFile() || out.length() < 10000000L || !out.canExecute()) {
                try {
                    Installer.extractGzipAsset(ctx, "php64.arm", out);
                } catch (Throwable t) {
                    return null;
                }
            }
            if (out.isFile() && out.canExecute()) return out;
        }
        return null;
    }

    private String cpuUnsupportedMessage() {
        boolean arm64 = hasAbi("arm64-v8a");
        boolean x64 = hasAbi("x86_64");
        if (!arm64 && !x64) {
            return "This device has a 32-bit CPU. PocketMine-MP 5 requires a 64-bit processor, "
                    + "so the server cannot run on this phone.";
        }
        if (arm64 && Build.VERSION.SDK_INT >= 29) {
            return "This phone runs a 32-bit version of Android on 64-bit hardware. "
                    + "Android 10 and above do not allow apps to unpack and run the 64-bit server binary, "
                    + "so PocketMine cannot start here.";
        }
        return "PHP server binary is missing on this device (setup problem). Reinstall the app and try again.";
    }

    public String stateName() {
        switch (state) {
            case STATE_STARTING: return "starting";
            case STATE_RUNNING: return "running";
            case STATE_STOPPING: return "stopping";
            case STATE_STOPPED: return "stopped";
            case STATE_CRASHED: return "crashed";
            default: return "idle";
        }
    }

    /** JSON object builder that never throws (safe inside lambdas/threads). */
    static JSONObject JO(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) {
                o.put(String.valueOf(kv[i]), kv[i + 1]);
            }
        } catch (JSONException ignored) {
        }
        return o;
    }

    public JSONObject ok() {
        return JO("ok", true);
    }

    public JSONObject err(String msg) {
        return JO("ok", false, "error", msg);
    }

    public synchronized JSONObject start() {
        if (isRunning() || state == STATE_STARTING) {
            return err("server is already running");
        }
        try {
            Installer.ensure(ctx, serverDir);
        } catch (Throwable e) {
            state = STATE_IDLE;
            return err("setup failed: " + Bridge.safeMsg(e));
        }

        // Every server MUST own a server.properties with its own UDP port: a
        // server started without one falls back to PocketMine's default 19132
        // and collides with any other server created afterwards.
        try {
            Installer.ensureServerProperties(ctx, serverDir);
            Installer.applyProfileMemory(ctx, profileId, serverDir);
        } catch (Throwable ignored) {
        }

        File php = resolvePhp();
        if (php == null) {
            state = STATE_CRASHED;
            lastError = cpuUnsupportedMessage();
            return err(lastError);
        }
        File phar = new File(serverDir, "PocketMine-MP.phar");
        if (!phar.isFile()) {
            state = STATE_IDLE;
            return err("PocketMine-MP.phar not found");
        }
        File ini = new File(serverDir, "php.ini");
        if (!ini.isFile()) {
            state = STATE_IDLE;
            return err("php.ini not found");
        }

        wantStop = false;
        exitCode = 0;
        lastError = null;
        cachedPid = 0;
        reaped.set(false);
        state = STATE_STARTING;
        startedAt = System.currentTimeMillis();

        // A new server session starts with a fresh console buffer; the web panel sees the
        // session counter change and clears its views too.
        synchronized (consoleLock) {
            consoleLines.clear();
            consoleSession++;
        }
        onlinePlayers.clear();
        tpsCurrent = tpsAverage = tickLoad = netUpKbps = netDownKbps = -1;
        tpsAt = lastStatusAt = 0;
        lastStatusBlock = "";
        lastListNum = lastListMax = -1;
        statusCollecting = false;
        lastCpuTicks = -1;
        cpuPercent = -1;

        /* Running a SECOND server needs its own ~450 MB of free RAM: without this
         * guard Android's low-memory killer silently murders one of the two PHP
         * processes and the user experiences "the two cannot run together". */
        try {
            int runningOthers = 0;
            for (String[] p : Profiles.all(ctx)) {
                if (p[0].equals(profileId)) continue;
                ServerManager other = ServerManager.peek(ctx, p[0]);
                if (other != null && other.isRunning()) runningOthers++;
            }
            android.app.ActivityManager am = (android.app.ActivityManager)
                    ctx.getSystemService(android.content.Context.ACTIVITY_SERVICE);
            if (am != null) {
                android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
                am.getMemoryInfo(mi);
                long need = (runningOthers > 0 ? 450L : 280L) * 1024 * 1024;
                long avail = mi.availMem + (mi.lowMemory ? 0 : 0);
                if (avail < need) {
                    state = STATE_IDLE;
                    return err("not enough free RAM to start this server (" + (avail / (1024 * 1024))
                            + " MB free, about " + (need / (1024 * 1024)) + " MB needed) - stop another server or free memory");
                }
            }
        } catch (Throwable ignored) {
        }

        // Port self-heal: if another RUNNING server already owns this profile's
        // UDP port, silently move this profile to a genuinely free one instead
        // of letting PocketMine crash at boot. (Creation already picks a unique
        // port; this only fixes legacy profiles created before that guard.)
        try {
            int myPort = Profiles.readPort(serverDir);
            if (myPort > 0) {
                for (String[] p : Profiles.all(ctx)) {
                    if (p[0].equals(profileId)) continue;
                    ServerManager other = ServerManager.peek(ctx, p[0]);
                    if (other != null && other.isRunning()
                            && Profiles.readPort(other.fs.getRoot()) == myPort) {
                        int np = Profiles.nextFreePort(ctx);
                        if (np != myPort) {
                            Installer.setServerPort(serverDir, np);
                            addConsole("[PMPanel] UDP port " + myPort + " is used by \""
                                    + p[1] + "\" - this server now uses " + np
                                    + " (change server-port in Settings if you prefer another)");
                        }
                        break;
                    }
                }
            }
        } catch (Throwable ignored) {
        }

        /* Source plugins (plugin.yml + src/ folders) are compiled to .phar right
         * here, on every start: no DevTools needed, edits are picked up on
         * restart. Users reported source plugins not loading even with DevTools
         * installed (its phar is usually built for another API version), so the
         * panel now does the job itself. Runs AFTER the console reset so the
         * compile lines land in the new session. */
        try {
            JSONObject compiled = PluginTools.autoCompileSourcePlugins(ctx, fs);
            JSONArray done = compiled.optJSONArray("compiled");
            for (int i = 0; done != null && i < done.length(); i++) {
                addConsole("[PMPanel] compiled source plugin -> plugins/" + done.optString(i));
            }
            JSONArray failed = compiled.optJSONArray("failed");
            for (int i = 0; failed != null && i < failed.length(); i++) {
                addConsole("[PMPanel] source plugin compile FAILED: " + failed.optString(i));
            }
        } catch (Throwable t) {
            addConsole("[PMPanel] source plugin scan failed: " + Bridge.safeMsg(t));
        }

        try {
            openLogFile();
            //noinspection ResultOfMethodCallIgnored
            tmpDir.mkdirs();

            ProcessBuilder pb = new ProcessBuilder(
                    php.getAbsolutePath(),
                    "-c", ini.getAbsolutePath(),
                    phar.getAbsolutePath(),
                    "--no-wizard",
                    "--no-log-file",
                    "--enable-ansi",
                    "--data=" + serverDir.getAbsolutePath(),
                    "--plugins=" + new File(serverDir, "plugins").getAbsolutePath());
            pb.directory(serverDir);
            pb.redirectErrorStream(true);
            java.util.Map<String, String> env = pb.environment();
            env.put("TMPDIR", tmpDir.getAbsolutePath());
            env.put("HOME", ctx.getFilesDir().getAbsolutePath());
            env.put("PATH", php.getParentFile().getAbsolutePath() + ":/system/bin:/system/xbin:/vendor/bin");
            env.remove("LD_PRELOAD");
            env.remove("LD_LIBRARY_PATH");
            // Do NOT set TERM: with TERM unset, PocketMine falls back to portable 256-color
            // ANSI codes; with TERM set it would try to shell out to `tput`, which does not
            // exist on Android, producing empty (colorless) escape codes.
            env.remove("TERM");

            addConsole("# " + profileName() + " - " +
                    new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date()));

            process = pb.start();
        } catch (Throwable t) {
            state = STATE_CRASHED;
            lastError = "failed to start process: " + Bridge.safeMsg(t);
            closeLogFile();
            addConsole("# ERROR: " + lastError);
            return err(lastError);
        }

        stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));

        final Process p = process;
        Thread reader = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8), 1 << 16)) {
                String line;
                while ((line = r.readLine()) != null) {
                    onConsoleLine(line);
                }
            } catch (Throwable ignored) {
            } finally {
                onProcessExit(p);
            }
        }, "pm-console-reader");
        reader.setDaemon(true);
        reader.start();

        ServerService.start(ctx);
        return ok();
    }

    public void stopAsync() {
        new Thread(() -> {
            stopInternal();
        }, "pm-stop").start();
    }

    public void restartAsync() {
        new Thread(() -> {
            stopInternal();
            try {
                Thread.sleep(600);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            start();
        }, "pm-restart").start();
    }

    private synchronized void stopInternal() {
        Process p = process;
        if (p == null) {
            return;
        }
        wantStop = true;
        if (state == STATE_RUNNING || state == STATE_STARTING) {
            state = STATE_STOPPING;
        }
        JSONObject r = sendCommand("stop");
        if (!r.optBoolean("ok")) {
            // maybe the reader is stuck; destroy directly
        }
        for (int i = 0; i < 250; i++) {
            if (!p.isAlive() || process != p) break;
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                break;
            }
        }
        if (p.isAlive() && process == p) {
            p.destroy();
            try {
                if (!p.waitFor(8, java.util.concurrent.TimeUnit.SECONDS)) {
                    p.destroyForcibly();
                    p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS);
                }
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private void onProcessExit(Process p) {
        if (!reaped.compareAndSet(false, true)) return;
        int code = -1;
        try {
            code = p.waitFor();
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        synchronized (this) {
            exitCode = code;
            boolean graceful = wantStop || code == 0;
            if (state != STATE_CRASHED || graceful) {
                state = graceful ? STATE_STOPPED : STATE_CRASHED;
            }
            if (state == STATE_CRASHED && lastError == null) {
                lastError = "process exited with code " + code;
            }
            if (lastError == null && !graceful) lastError = "process exited with code " + code;
            stdin = null;
            process = null;
            closeLogFile();
        }
        // the foreground service only goes away when the LAST server stops;
        // while others still run, its notification is refreshed (name list)
        if (anyRunning()) ServerService.start(ctx);
        else ServerService.stop(ctx);
    }

    public synchronized JSONObject sendCommand(String cmd) {
        BufferedWriter w = stdin;
        Process p = process;
        if (w == null || p == null || !p.isAlive()) {
            return err("server is not running");
        }
        try {
            w.write(cmd);
            w.write("\n");
            w.flush();
        } catch (IOException e) {
            return err("failed to write command: " + Bridge.safeMsg(e));
        }
        return ok();
    }

    private void onConsoleLine(String line) {
        addConsole(line);
        if (line.contains("For help, type")) {
            if (state == STATE_STARTING) state = STATE_RUNNING;
        } else if (line.contains("An unrecoverable error has occurred")) {
            state = STATE_CRASHED;
            lastError = "server crashed (see logs)";
        }
        analyzeLine(line);
    }

    /* ---------------- v2.7 console analysis (statistics source) ---------------- */

    private static String stripAnsi(String s) {
        if (s.indexOf(0x1B) < 0) return s;
        StringBuilder sb = new StringBuilder(s.length());
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == 0x1B) {
                int j = i + 1;
                if (j < s.length() && s.charAt(j) == '[') {
                    j++;
                    while (j < s.length() && (Character.isDigit(s.charAt(j)) || s.charAt(j) == ';')) j++;
                    if (j < s.length() && s.charAt(j) == 'm') j++;
                } else {
                    j = Math.min(j + 1, s.length());
                }
                i = j;
                continue;
            }
            sb.append(c);
            i++;
        }
        return sb.toString();
    }

    private void analyzeLine(String raw) {
        String line = stripAnsi(raw);
        try {
            int ji = line.indexOf(" joined the game");
            if (ji > 0) {
                String name = playerNameFromConsole(line, ji);
                if (!name.isEmpty()) synchronized (onlinePlayers) { onlinePlayers.add(name); }
            }
            int li = line.indexOf(" left the game");
            if (li > 0) {
                String name = playerNameFromConsole(line, li);
                if (!name.isEmpty()) synchronized (onlinePlayers) { onlinePlayers.remove(name); }
            }
            int li2 = line.indexOf("players online:");
            if (li2 > 0) {
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("There are (\\d+)/(\\d+) players online")
                        .matcher(line);
                if (m.find()) {
                    lastListNum = Integer.parseInt(m.group(1));
                    lastListMax = Integer.parseInt(m.group(2));
                }
            }
            if (line.contains("Current TPS:")) {
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("Current TPS:\\s*([0-9]+(?:\\.[0-9]+)?)").matcher(line);
                if (m.find()) {
                    tpsCurrent = Double.parseDouble(m.group(1));
                    tpsAt = System.currentTimeMillis();
                }
                java.util.regex.Matcher ml = java.util.regex.Pattern
                        .compile("\\(([0-9]+(?:\\.[0-9]+)?)%\\)").matcher(line);
                if (ml.find()) tickLoad = Double.parseDouble(ml.group(1));
                /* the /status reply block: capture this line + the following ones */
                statusCollecting = true;
                statusCollected = 1;
                statusBuf.setLength(0);
                statusBuf.append(line);
                lastStatusAt = System.currentTimeMillis();
            } else if (statusCollecting) {
                statusBuf.append('\n').append(line);
                statusCollected++;
                if (statusCollected >= 16 || line.contains("Average TPS") == false && statusCollected > 3 && !isStatusContinuation(line)) {
                    lastStatusBlock = statusBuf.toString();
                    statusCollecting = false;
                }
                if (line.contains("Average TPS:")) {
                    java.util.regex.Matcher m = java.util.regex.Pattern
                            .compile("Average TPS:\\s*([0-9]+(?:\\.[0-9]+)?)").matcher(line);
                    if (m.find()) tpsAverage = Double.parseDouble(m.group(1));
                } else if (line.contains("Network upload:")) {
                    netUpKbps = parseKbps(line);
                } else if (line.contains("Network download:")) {
                    netDownKbps = parseKbps(line);
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private static boolean isStatusContinuation(String line) {
        return line.contains("Network") || line.contains("memory") || line.contains("Memory")
                || line.contains("Thread") || line.contains("World") || line.contains("chunks")
                || line.contains("entities") || line.contains("TPS") || line.contains("Load")
                || line.contains("kB/s") || line.contains("MB");
    }

    private static double parseKbps(String line) {
        try {
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("([0-9]+(?:\\.[0-9]+)?) kB/s").matcher(line);
            if (m.find()) return Double.parseDouble(m.group(1));
        } catch (Throwable ignored) {
        }
        return -1;
    }

    private static String playerNameFromConsole(String line, int idx) {
        String s = line.substring(0, idx).trim();
        int c = s.lastIndexOf("]: ");
        if (c >= 0) s = s.substring(c + 3).trim();
        // PM5 formats like "Player [Steve/xuid]" or plain "Steve"
        if (s.startsWith("Player [")) {
            s = s.substring(8);
            int slash = s.indexOf('/');
            if (slash > 0) s = s.substring(0, slash);
            s = s.replace("]", "").trim();
        }
        if (s.length() > 40 || s.isEmpty() || s.contains(" ") && s.contains("[")) return "";
        return s;
    }

    private void addConsole(String line) {
        synchronized (consoleLock) {
            seq++;
            consoleLines.addLast(seq + "\u0001" + line);
            while (consoleLines.size() > MAX_CONSOLE_LINES) consoleLines.removeFirst();
        }
        BufferedWriter w = logWriter;
        if (w != null) {
            try {
                w.write(line);
                w.newLine();
                w.flush();
            } catch (IOException ignored) {
            }
        }
    }

    public long lastSeq() {
        synchronized (consoleLock) {
            return seq;
        }
    }

    public JSONObject consoleSince(long after) throws JSONException {
        JSONArray arr = new JSONArray();
        long last;
        synchronized (consoleLock) {
            last = seq;
            for (String entry : consoleLines) {
                int i = entry.indexOf('\u0001');
                if (i <= 0) continue;
                try {
                    long s = Long.parseLong(entry.substring(0, i));
                    if (s > after) {
                        JSONArray pair = new JSONArray();
                        pair.put(s);
                        pair.put(entry.substring(i + 1));
                        arr.put(pair);
                    }
                } catch (NumberFormatException ignored) {
                }
            }
        }
        JSONObject res = new JSONObject();
        res.put("ok", true);
        res.put("lines", arr);
        res.put("last", last);
        res.put("session", consoleSession);
        return res;
    }

    public JSONObject status() throws JSONException {
        JSONObject res = new JSONObject();
        res.put("ok", true);
        res.put("state", stateName());
        res.put("uptimeSec", uptimeSec());
        res.put("pid", pidOf());
        res.put("exitCode", exitCode);
        if (lastError != null) res.put("lastError", lastError);
        res.put("rssKb", readRss());
        res.put("freeSpace", serverDir.getFreeSpace());
        res.put("consoleLast", lastSeq());
        res.put("session", consoleSession);
        res.put("profile", profileId);
        res.put("name", profileName());
        /* v2.7 statistics fields */
        res.put("cpuPercent", Math.round(sampleCpu() * 10.0) / 10.0);
        JSONArray players = new JSONArray();
        synchronized (onlinePlayers) {
            for (String p : onlinePlayers) players.put(p);
        }
        res.put("playersOnline", players);
        res.put("playersCount", players.length());
        if (lastListMax > 0) {
            res.put("playersMax", lastListMax);
        } else {
            res.put("playersMax", maxPlayersFromProps());
        }
        if (tpsAt > 0) res.put("tpsCurrent", tpsCurrent);
        if (tpsAverage >= 0) res.put("tpsAverage", tpsAverage);
        if (tickLoad >= 0) res.put("tickLoad", tickLoad);
        if (netUpKbps >= 0) res.put("netUpKbps", netUpKbps);
        if (netDownKbps >= 0) res.put("netDownKbps", netDownKbps);
        if (tpsAt > 0) res.put("tpsAgeSec", (System.currentTimeMillis() - tpsAt) / 1000);
        if (lastStatusBlock.length() > 0) {
            res.put("lastStatus", lastStatusBlock);
            res.put("lastStatusAgeSec", (System.currentTimeMillis() - lastStatusAt) / 1000);
        }
        return res;
    }

    private int maxPlayersFromProps() {
        try {
            for (int i = 0; i < 200; i++) {
                File f = new File(serverDir, "server.properties");
                if (!f.isFile()) return 20;
                for (String line : java.nio.file.Files.readAllLines(f.toPath(), StandardCharsets.UTF_8)) {
                    if (line.startsWith("max-players=")) {
                        return Integer.parseInt(line.substring(12).trim());
                    }
                }
                return 20;
            }
        } catch (Throwable ignored) {
        }
        return 20;
    }

    /** CPU% of the php process: utime+stime delta from /proc/<pid>/stat. */
    private double sampleCpu() {
        long pid = pidOf();
        if (pid <= 0) return -1;
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream("/proc/" + pid + "/stat")))) {
            String st = r.readLine();
            if (st == null) return -1;
            // field 14 = utime, 15 = stime (comm may contain spaces, fields start after last ')')
            int close = st.lastIndexOf(')');
            String[] sp = st.substring(close + 2).split("\\s+");
            long utime = Long.parseLong(sp[11]);  // 14 - 3 (state, ppid, pgrp)
            long stime = Long.parseLong(sp[12]);
            long now = System.currentTimeMillis();
            double cpu = -1;
            if (lastCpuTicks >= 0 && now > lastCpuAt) {
                double dtSec = (now - lastCpuAt) / 1000.0;
                long dTicks = (utime + stime) - lastCpuTicks;
                if (dtSec >= 0.3 && dTicks >= 0) {
                    cpu = (dTicks / 100.0) / dtSec * 100.0; // CLK_TCK = 100 on Android
                    if (cpu > 800) cpu = 800;
                }
            }
            lastCpuTicks = utime + stime;
            lastCpuAt = now;
            cpuPercent = cpu;
            return cpu;
        } catch (Throwable ignored) {
        }
        return -1;
    }

    /** Players currently on this server (console join/leave tracking). */
    public java.util.List<String> currentPlayers() {
        synchronized (onlinePlayers) {
            return new java.util.ArrayList<>(onlinePlayers);
        }
    }

    private volatile long cachedPid = 0;

    /**
     * Find THIS server's php pid by scanning /proc cmdlines (Process.pid() is
     * not in the Android API). With several servers running, the first
     * "libpmphp.so" hit is not enough - the full argument list is matched
     * against this profile's --data directory.
     */
    private long findPid() {
        if (cachedPid > 0) return cachedPid;
        String marker = "--data=" + serverDir.getAbsolutePath();
        try {
            File[] all = new File("/proc").listFiles();
            if (all == null) return 0;
            for (File f : all) {
                String n = f.getName();
                if (n.isEmpty() || !Character.isDigit(n.charAt(0))) continue;
                try {
                    byte[] raw = new byte[4096];
                    int len;
                    try (FileInputStream in = new FileInputStream(new File(f, "cmdline"))) {
                        len = in.read(raw);
                    }
                    if (len <= 0) continue;
                    String cmdline = new String(raw, 0, len, StandardCharsets.ISO_8859_1)
                            .replace('\u0000', ' ');
                    if (cmdline.contains("libpmphp.so") && cmdline.contains(marker)) {
                        cachedPid = Long.parseLong(n);
                        return cachedPid;
                    }
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
        return 0;
    }

    private long pidOf() {
        return process == null ? 0 : findPid();
    }

    private long readRss() {
        long pid = pidOf();
        if (pid <= 0) return 0;
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream("/proc/" + pid + "/status")))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (line.startsWith("VmRSS:")) {
                    String[] sp = line.trim().split("\\s+");
                    if (sp.length >= 2) return Long.parseLong(sp[1]);
                }
            }
        } catch (Throwable ignored) {
        }
        return 0;
    }

    private void openLogFile() throws IOException {
        closeLogFile();
        File logs = new File(serverDir, "logs");
        //noinspection ResultOfMethodCallIgnored
        logs.mkdirs();
        rotateLogs(logs);
        String stamp = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(new Date());
        currentLogFile = new File(logs, "server-" + stamp + ".log");
        logWriter = new BufferedWriter(new OutputStreamWriter(
                new FileOutputStream(currentLogFile), StandardCharsets.UTF_8));
    }

    private void rotateLogs(File logs) {
        File[] files = logs.listFiles();
        if (files == null || files.length <= KEEP_LOGS) return;
        Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (int i = 0; i < files.length - KEEP_LOGS; i++) {
            //noinspection ResultOfMethodCallIgnored
            files[i].delete();
        }
    }

    private void closeLogFile() {
        BufferedWriter w = logWriter;
        logWriter = null;
        if (w != null) {
            try {
                w.close();
            } catch (IOException ignored) {
            }
        }
    }
}
