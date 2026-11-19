package com.pmpanel.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.Locale;

/**
 * Plugin compiler / decompiler - PURE JAVA, no PHP involved.
 *
 * The v2.2 and earlier implementation shelled out to the bundled static PHP
 * binary (pmtools.php) and failed on real devices:
 *   IOException: Cannot run program '.../lib/arm64/libpmphp.so' ... error=2
 * (the packed .so cannot be exec'd on many phones, and the working directory
 * src/ did not exist). Compiling is now done entirely in-process through
 * {@link Phar}, so it works on every device, needs no installed server, and
 * needs no PHP binary at all.
 *
 *  compile:   <folder with plugin.yml> or <plugin .zip>  ->  compiled/<Name>.phar
 *  decompile: <plugin .phar> or <plugin .zip>            ->  src/<name>/
 */
public final class PluginTools {

    private PluginTools() {
    }

    /* ================= auto-compile at server start ================= */

    /**
     * Compile every source plugin folder in plugins/ (dir with plugin.yml +
     * src/) into plugins/<Name>.phar. Called by ServerManager.start() so
     * source plugins load WITHOUT DevTools - users reported that even with
     * DevTools installed, source folders never load (most DevTools phars are
     * built for a different PocketMine API version and get rejected).
     * PocketMine collapses duplicate plugin names to one instance, so this is
     * also safe when a working DevTools happens to be installed.
     *
     * @return {compiled:[file names], failed:[error strings]}
     */
    public static JSONObject autoCompileSourcePlugins(Context ctx, Fs fs) {
        JSONArray compiled = new JSONArray();
        JSONArray failed = new JSONArray();
        try {
            File pluginsDir = fs.resolve("plugins");
            File[] kids = pluginsDir.listFiles();
            if (kids != null) {
                java.util.Arrays.sort(kids, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
                for (File f : kids) {
                    if (!f.isDirectory()) continue;
                    if (!new File(f, "plugin.yml").isFile()) continue;
                    if (!new File(f, "src").isDirectory()) continue;
                    try {
                        String name = pharNameFor(f);
                        File out = new File(pluginsDir, name);
                        Phar.write(f, out, name);
                        compiled.put(name);
                    } catch (Throwable t) {
                        failed.put(f.getName() + ": " + Bridge.safeMsg(t));
                    }
                }
            }
        } catch (Throwable t) {
            failed.put(Bridge.safeMsg(t));
        }
        return ServerManager.JO("compiled", compiled, "failed", failed);
    }

    /** Output phar name for a source folder: plugin.yml name (sanitized) + .phar. */
    private static String pharNameFor(File srcDir) {
        String name = "";
        try {
            JSONObject meta = PharMeta.pluginMeta(srcDir);
            name = meta.optString("name", "");
        } catch (Throwable ignored) {
        }
        if (name.isEmpty()) name = srcDir.getName();
        name = name.replaceAll("[^A-Za-z0-9._\\-]", "_");
        if (name.isEmpty()) name = "plugin";
        if (!name.toLowerCase(Locale.US).endsWith(".phar")) name += ".phar";
        return name;
    }

    /* ================= compile ================= */

    /** Compile a source plugin (folder or .zip) into <serverDir>/compiled/<name>.phar */
    public static JSONObject compile(Context ctx, Fs fs, String srcPath, String outName) {
        try {
            if (srcPath == null || srcPath.trim().isEmpty()) {
                return err("no source path");
            }
            File src = fs.resolve(srcPath.trim());
            if (!src.exists()) {
                return err("source not found: " + srcPath);
            }

            /* zip upload: extract to a fresh folder under src/ first */
            String note = null;
            if (src.isFile()) {
                String lower = src.getName().toLowerCase(Locale.US);
                if (!lower.endsWith(".zip")) {
                    return err("compile source must be a folder or a .zip (got: " + src.getName() + ")");
                }
                File dir = uniqueDir(ctx, baseName(src.getName()));
                int n = fs.unzip(srcPath.trim(), rel(fs, dir));
                File extracted = dir;
                /* zips often wrap everything in one top folder - use it directly */
                File wrapped = singleChildDir(extracted);
                if (wrapped != null && new File(wrapped, "plugin.yml").isFile()) extracted = wrapped;
                if (!new File(extracted, "plugin.yml").isFile()) {
                    return err("plugin.yml not found in the zip root");
                }
                src = extracted;
                note = "unpacked " + n + " files";
            }

            if (!new File(src, "plugin.yml").isFile()) {
                return err("plugin.yml not found in the folder root");
            }

            /* output name: explicit > plugin.yml (name + version) > folder name */
            String name = outName == null ? "" : outName.trim();
            if (name.isEmpty()) {
                JSONObject meta = PharMeta.pluginMeta(src);
                String pn = meta.optString("name", "");
                String pv = meta.optString("version", "");
                if (!pn.isEmpty()) {
                    name = pv.isEmpty() ? pn : pn + "_v" + pv;
                }
            }
            if (name.isEmpty()) name = src.getName();
            name = name.replaceAll("[^A-Za-z0-9._\\-]", "_");
            if (name.isEmpty()) name = "plugin";
            if (!name.toLowerCase(Locale.US).endsWith(".phar")) name += ".phar";

            File compiledDir = new File(Installer.serverDir(ctx), "compiled");
            //noinspection ResultOfMethodCallIgnored
            compiledDir.mkdirs();

            int files = Phar.write(src, new File(compiledDir, name), name);

            JSONObject r = ServerManager.JO("ok", true,
                    "file", "compiled/" + name,
                    "files", files,
                    "size", new File(compiledDir, name).length());
            if (note != null) r.put("note", note);
            return r;
        } catch (Throwable t) {
            return err(Bridge.safeMsg(t));
        }
    }

    /* ================= decompile ================= */

    /** Extract a .phar (or plugin .zip) into <serverDir>/src/<name>/ */
    public static JSONObject decompile(Context ctx, Fs fs, String srcPath) {
        try {
            if (srcPath == null || srcPath.trim().isEmpty()) {
                return err("no source path");
            }
            File src = fs.resolve(srcPath.trim());
            if (!src.isFile()) {
                return err("file not found: " + srcPath);
            }
            String lower = src.getName().toLowerCase(Locale.US);
            if (!lower.endsWith(".phar") && !lower.endsWith(".zip")) {
                return err("only .phar and .zip can be decompiled");
            }
            File dir = uniqueDir(ctx, baseName(src.getName()));
            int n;
            if (lower.endsWith(".phar")) {
                n = Phar.extract(src, dir);
            } else {
                n = fs.unzip(srcPath.trim(), rel(fs, dir));
            }
            return ServerManager.JO("ok", true,
                    "file", rel(fs, dir),
                    "files", n,
                    "size", Fs2.dirSize(dir));
        } catch (Throwable t) {
            return err(Bridge.safeMsg(t));
        }
    }

    /* ================= helpers ================= */

    private static JSONObject err(String msg) {
        return ServerManager.JO("ok", false, "error", msg);
    }

    private static String baseName(String n) {
        String b = n.replaceAll("\\.(phar|zip)$", "");
        b = b.replaceAll("[^A-Za-z0-9._\\-]", "_");
        return b.isEmpty() ? "plugin" : b;
    }

    /** src/<base>, src/<base>_2, src/<base>_3 ... - never over an existing one. */
    private static File uniqueDir(Context ctx, String base) throws IOException {
        File srcRoot = new File(Installer.serverDir(ctx), "src");
        //noinspection ResultOfMethodCallIgnored
        srcRoot.mkdirs();
        File dir = new File(srcRoot, base);
        int n = 2;
        while (dir.exists()) dir = new File(srcRoot, base + "_" + n++);
        if (!dir.mkdirs()) throw new IOException("cannot create " + dir.getName());
        return dir;
    }

    /** Sandbox-relative path of a file inside the server dir. */
    private static String rel(Fs fs, File f) throws IOException {
        String root = fs.getRoot().getCanonicalPath();
        String p = f.getCanonicalPath();
        if (p.equals(root)) return "";
        if (!p.startsWith(root + File.separator)) throw new IOException("path escapes sandbox");
        return p.substring(root.length() + 1).replace(File.separatorChar, '/');
    }

    /** The single sub-directory of dir, or null when dir has other content. */
    private static File singleChildDir(File dir) {
        File[] kids = dir.listFiles();
        if (kids == null || kids.length != 1 || !kids[0].isDirectory()) return null;
        return kids[0];
    }

    /** dirSize without going through Fs (which needs a sandbox path). */
    private static class Fs2 {
        static long dirSize(File f) {
            if (f == null || !f.exists()) return 0;
            if (f.isFile()) return f.length();
            long total = 0;
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) total += dirSize(k);
            return total;
        }
    }
}
