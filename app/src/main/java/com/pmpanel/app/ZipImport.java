package com.pmpanel.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * "Import config package": drop ONE zip containing anything server-related -
 * plugins (.phar or source folders), worlds, resource packs, server.properties,
 * pocketmine.yml, player/list files, plugin_data - and the panel figures out
 * what is inside and puts every piece in the right place of the chosen server
 * profile.
 *
 * Flow (both steps async on the bridge):
 *   zipimport.analyze  {path}   -> extracts to a private staging dir, classifies
 *                                  the tree, returns {stageId, ...categories}
 *   zipimport.apply    {stageId}-> moves everything into the profile dir
 *
 * Zips that wrap their content in a single top folder ("Backup/PocketMine/...")
 * are unwrapped automatically (up to 3 levels).
 */
public final class ZipImport {

    private static final long MAX_TOTAL = 2L * 1024 * 1024 * 1024; // 2 GB staging cap
    private static final int MAX_ENTRIES = 100000;
    private static final long STAGE_TTL_MS = 30 * 60 * 1000L;

    /** stageId -> staging dir (analyzed, waiting for the user's Apply). */
    private static final Map<String, File> stages = new HashMap<>();

    private ZipImport() {
    }

    /* ================= analyze ================= */

    public static synchronized JSONObject analyze(Context ctx, Fs fs, String zipRel) {
        try {
            File zip = fs.resolve(zipRel);
            if (!zip.isFile()) return err("zip not found: " + zipRel);
            cleanOldStages();

            File staging = new File(stageBase(),
                    "import-" + System.currentTimeMillis());
            //noinspection ResultOfMethodCallIgnored
            staging.mkdirs();
            extractZip(zip, staging);

            File root = unwrap(staging);
            JSONObject r = classify(root);
            String stageId = "z" + System.currentTimeMillis();
            stages.put(stageId, staging);
            r.put("ok", true);
            r.put("stageId", stageId);
            r.put("stageRootName", root.getName());
            return r;
        } catch (Throwable t) {
            return err(Bridge.safeMsg(t));
        }
    }

    /* ================= apply ================= */

    public static synchronized JSONObject apply(Context ctx, Fs fs, String stageId) {
        try {
            File staging = stages.remove(stageId);
            if (staging == null || !staging.isDirectory()) {
                return err("import session expired - analyze the zip again");
            }
            File root = unwrap(staging);
            JSONObject r = applyTree(fs.getRoot(), root);
            deleteRec(staging);
            r.put("ok", true);
            return r;
        } catch (Throwable t) {
            return err(Bridge.safeMsg(t));
        }
    }

    /* ================= classification ================= */

    private static final String[] CONFIG_FILES = {
            "server.properties", "pocketmine.yml", "php.ini",
            "ops.txt", "banned-players.txt", "banned-ips.txt",
            "whitelist.txt", "white-list.txt", "plugin_list.yml",
    };
    private static final String[] DATA_DIRS = {"plugin_data", "players"};

    /** Turn the staging tree into a category summary for the confirm modal. */
    private static JSONObject classify(File root) throws IOException, org.json.JSONException {
        List<File> plugins = new ArrayList<>();
        List<File> worlds = new ArrayList<>();
        List<File> packs = new ArrayList<>();
        List<String> configs = new ArrayList<>();
        List<String> data = new ArrayList<>();
        int skipped = 0;

        File[] kids = root.listFiles();
        if (kids != null) {
            Arrays.sort(kids, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
            for (File f : kids) {
                String n = f.getName().toLowerCase(Locale.US);
                if (f.isDirectory()) {
                    if (n.equals("plugins")) {
                        addChildren(f, plugins);
                    } else if (n.equals("worlds")) {
                        addChildren(f, worlds);
                    } else if (n.equals("resource_packs")) {
                        addChildren(f, packs);
                    } else if (isDataDir(n)) {
                        data.add(f.getName());
                    } else if (new File(f, "plugin.yml").isFile()) {
                        plugins.add(f);
                    } else if (new File(f, "level.dat").isFile()) {
                        worlds.add(f);
                    } else {
                        skipped++;
                    }
                } else if (n.endsWith(".phar") || n.endsWith(".zip")) {
                    plugins.add(f);
                } else if (n.endsWith(".mcpack")) {
                    packs.add(f);
                } else if (isConfigFile(f.getName())) {
                    configs.add(f.getName());
                } else {
                    skipped++;
                }
            }
        }
        JSONObject r = new JSONObject();
        r.put("plugins", names(plugins));
        r.put("worlds", names(worlds));
        r.put("packs", names(packs));
        r.put("configs", new JSONArray(configs));
        r.put("data", new JSONArray(data));
        r.put("skipped", skipped);
        r.put("plugins_c", plugins.size());
        r.put("worlds_c", worlds.size());
        r.put("packs_c", packs.size());
        r.put("configs_c", configs.size());
        return r;
    }

    /** Move every classified item into the profile directory. */
    private static JSONObject applyTree(File profileDir, File root) throws IOException {
        int plugins = 0, worlds = 0, packs = 0, configs = 0, data = 0, skipped = 0;
        File[] kids = root.listFiles();
        if (kids != null) {
            for (File f : kids) {
                String n = f.getName().toLowerCase(Locale.US);
                if (f.isDirectory()) {
                    if (n.equals("plugins")) {
                        plugins += moveChildren(f, new File(profileDir, "plugins"));
                    } else if (n.equals("worlds")) {
                        worlds += moveChildren(f, new File(profileDir, "worlds"));
                    } else if (n.equals("resource_packs")) {
                        packs += moveChildren(f, new File(profileDir, "resource_packs"));
                    } else if (isDataDir(n)) {
                        moveOver(f, new File(profileDir, f.getName()));
                        data++;
                    } else if (new File(f, "plugin.yml").isFile()) {
                        moveOver(f, new File(new File(profileDir, "plugins"), f.getName()));
                        plugins++;
                    } else if (new File(f, "level.dat").isFile()) {
                        moveOver(f, new File(new File(profileDir, "worlds"), f.getName()));
                        worlds++;
                    } else {
                        skipped++;
                    }
                } else if (n.endsWith(".phar") || n.endsWith(".zip")) {
                    moveOver(f, new File(new File(profileDir, "plugins"), f.getName()));
                    plugins++;
                } else if (n.endsWith(".mcpack")) {
                    moveOver(f, new File(new File(profileDir, "resource_packs"), f.getName()));
                    packs++;
                } else if (isConfigFile(f.getName())) {
                    moveOver(f, new File(profileDir, f.getName()));
                    configs++;
                } else {
                    skipped++;
                }
            }
        }
        return ServerManager.JO(
                "plugins", plugins, "worlds", worlds, "packs", packs,
                "configs", configs, "data", data, "skipped", skipped);
    }

    private static void addChildren(File dir, List<File> out) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        Arrays.sort(kids, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
        for (File k : kids) out.add(k);
    }

    private static int moveChildren(File dir, File destDir) throws IOException {
        //noinspection ResultOfMethodCallIgnored
        destDir.mkdirs();
        File[] kids = dir.listFiles();
        if (kids == null) return 0;
        int n = 0;
        Arrays.sort(kids, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
        for (File k : kids) {
            moveOver(k, new File(destDir, k.getName()));
            n++;
        }
        return n;
    }

    /** Move src to dest (replace). Falls back to copy+delete across filesystems. */
    private static void moveOver(File src, File dest) throws IOException {
        if (isBadName(src.getName())) throw new IOException("bad entry name: " + src.getName());
        //noinspection ResultOfMethodCallIgnored
        dest.getParentFile().mkdirs();
        if (dest.exists()) deleteRec(dest);
        if (!src.renameTo(dest)) {
            if (src.isDirectory()) {
                //noinspection ResultOfMethodCallIgnored
                dest.mkdirs();
                File[] kids = src.listFiles();
                if (kids != null) {
                    for (File k : kids) moveOver(k, new File(dest, k.getName()));
                }
            } else {
                try (InputStream in = new FileInputStream(src);
                     OutputStream out = new FileOutputStream(dest)) {
                    byte[] buf = new byte[65536];
                    int r;
                    while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
                }
            }
            deleteRec(src);
        }
    }

    private static boolean isBadName(String n) {
        return n.isEmpty() || n.equals(".") || n.equals("..") || n.contains("/") || n.contains("\\") || n.indexOf('\0') >= 0;
    }

    private static boolean isConfigFile(String n) {
        for (String c : CONFIG_FILES) if (c.equals(n)) return true;
        return false;
    }

    private static boolean isDataDir(String n) {
        for (String d : DATA_DIRS) if (d.equals(n)) return true;
        return false;
    }

    private static JSONArray names(List<File> files) {
        JSONArray a = new JSONArray();
        for (File f : files) a.put(f.getName());
        return a;
    }

    /* ================= zip helpers ================= */

    /** Extract a zip safely (traversal + size + entry-count guards). */
    private static void extractZip(File zip, File destDir) throws IOException {
        long total = 0;
        int entries = 0;
        String destRoot = destDir.getCanonicalPath();
        try (ZipInputStream zin = new ZipInputStream(
                new BufferedInputStream(new FileInputStream(zip), 1 << 16))) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                if (++entries > MAX_ENTRIES) throw new IOException("too many zip entries");
                String name = e.getName();
                if (name.startsWith("__MACOSX") || name.contains("..")) continue;
                File out = new File(destDir, name);
                String op = out.getCanonicalPath();
                if (!op.equals(destRoot) && !op.startsWith(destRoot + File.separator)) continue;
                if (e.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    out.mkdirs();
                    continue;
                }
                //noinspection ResultOfMethodCallIgnored
                out.getParentFile().mkdirs();
                try (OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[65536];
                    int r;
                    while ((r = zin.read(buf)) > 0) {
                        os.write(buf, 0, r);
                        total += r;
                        if (total > MAX_TOTAL) throw new IOException("zip too large to import");
                    }
                }
            }
        }
    }

    /**
     * Zips exported by other tools often wrap everything in one folder.
     * Descend while the root contains exactly ONE directory and nothing else.
     */
    private static File unwrap(File root) {
        for (int i = 0; i < 3; i++) {
            File[] kids = root.listFiles();
            if (kids == null || kids.length != 1 || !kids[0].isDirectory()) return root;
            root = kids[0];
        }
        return root;
    }

    private static void cleanOldStages() {
        long now = System.currentTimeMillis();
        List<String> dead = new ArrayList<>();
        synchronized (ZipImport.class) {
            for (Map.Entry<String, File> e : stages.entrySet()) {
                if (now - e.getValue().lastModified() > STAGE_TTL_MS) dead.add(e.getKey());
            }
            for (String k : dead) {
                deleteRec(stages.remove(k));
            }
        }
        File[] kids = stageBase().listFiles();
        if (kids != null) {
            for (File k : kids) {
                if (k.isDirectory() && now - k.lastModified() > STAGE_TTL_MS) deleteRec(k);
            }
        }
    }

    /** Parent dir that holds all staging dirs. */
    private static File stageBase() {
        File base = Installer.cacheTmpStageBase();
        //noinspection ResultOfMethodCallIgnored
        base.mkdirs();
        return base;
    }

    private static void deleteRec(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRec(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static JSONObject err(String msg) {
        return ServerManager.JO("ok", false, "error", msg);
    }
}
