package com.pmpanel.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/** Sandboxed filesystem operations rooted at the server directory. */
public class Fs {

    private static final List<String> BACKUP_EXCLUDE_DIRS = Arrays.asList("logs", "crashdumps", "tmp", "backups", "uploads");
    private static final List<String> BACKUP_EXCLUDE_FILES = Arrays.asList(
            "PocketMine-MP.phar", "PocketMine-MP.phar.bak", "php.ini", "server.lock", "server.log");

    private final File root;

    public Fs(File root) {
        this.root = root;
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
    }

    public File getRoot() {
        return root;
    }

    /** Resolve a relative path inside the sandbox; blocks traversal. */
    public File resolve(String rel) throws IOException {
        if (rel == null) rel = "";
        rel = rel.replace('\\', '/');
        while (rel.startsWith("/")) rel = rel.substring(1);
        String rootPath = root.getCanonicalPath();
        File f = rel.isEmpty() ? root : new File(root, rel);
        String fp = f.getCanonicalPath();
        if (!fp.equals(rootPath) && !fp.startsWith(rootPath + File.separator)) {
            throw new IOException("path escapes sandbox");
        }
        return f;
    }

    /** Read up to maxBytes from a file into a byte array (throws if larger). */
    public static byte[] readBytes(File f, int maxBytes) throws IOException {
        if (f.length() > maxBytes) throw new IOException("file too large: " + f.getName());
        byte[] buf = new byte[(int) f.length()];
        try (FileInputStream in = new FileInputStream(f)) {
            int off = 0;
            while (off < buf.length) {
                int r = in.read(buf, off, buf.length - off);
                if (r < 0) break;
                off += r;
            }
            if (off < buf.length) {
                byte[] exact = new byte[off];
                System.arraycopy(buf, 0, exact, 0, off);
                return exact;
            }
        }
        return buf;
    }

    /** Total size of a file or all files under a directory (depth-capped). */
    public long dirSize(File f) {
        return dirSize(f, 0);
    }

    private long dirSize(File f, int depth) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        if (depth > 40) return 0; // guard against pathological nesting (StackOverflow)
        long total = 0;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) total += dirSize(c, depth + 1);
        return total;
    }

    public JSONObject ls(String rel) throws IOException, JSONException {
        File dir = resolve(rel);
        if (!dir.exists()) throw new IOException("not found");
        if (!dir.isDirectory()) throw new IOException("not a directory");
        JSONArray arr = new JSONArray();
        File[] children = dir.listFiles();
        if (children != null) {
            Arrays.sort(children, (a, b) -> {
                if (a.isDirectory() != b.isDirectory()) return a.isDirectory() ? -1 : 1;
                return a.getName().compareToIgnoreCase(b.getName());
            });
            for (File c : children) {
                JSONObject o = new JSONObject();
                o.put("name", c.getName());
                o.put("dir", c.isDirectory());
                o.put("size", c.length());
                o.put("mtime", c.lastModified());
                arr.put(o);
            }
        }
        JSONObject res = new JSONObject();
        res.put("path", rel);
        res.put("entries", arr);
        res.put("freeSpace", root.getFreeSpace());
        res.put("totalSpace", root.getTotalSpace());
        return res;
    }

    public JSONObject readText(String rel, int maxBytes) throws IOException, JSONException {
        File f = resolve(rel);
        if (!f.exists()) throw new IOException("file not found");
        if (f.isDirectory()) throw new IOException("is a directory");
        long len = f.length();
        boolean truncated = len > maxBytes;
        int n = (int) Math.min(len, maxBytes);
        byte[] buf = new byte[Math.max(n, 0)];
        try (FileInputStream in = new FileInputStream(f)) {
            int off = 0;
            while (off < n) {
                int r = in.read(buf, off, n - off);
                if (r < 0) break;
                off += r;
            }
        }
        boolean binary = false;
        int scan = Math.min(buf.length, 8192);
        for (int i = 0; i < scan; i++) {
            if (buf[i] == 0) {
                binary = true;
                break;
            }
        }
        JSONObject res = new JSONObject();
        res.put("content", new String(buf, StandardCharsets.UTF_8));
        res.put("size", len);
        res.put("truncated", truncated);
        res.put("binary", binary);
        res.put("name", f.getName());
        return res;
    }

    public void writeText(String rel, String content) throws IOException {
        File f = resolve(rel);
        File parent = f.getParentFile();
        if (parent != null) //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        File tmp = new File(parent, "." + f.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.getFD().sync();
        }
        if (f.exists() && !f.delete()) throw new IOException("cannot replace file");
        if (!tmp.renameTo(f)) throw new IOException("cannot write file");
    }

    public void mkdir(String rel) throws IOException {
        File f = resolve(rel);
        if (!f.exists() && !f.mkdirs()) throw new IOException("cannot create folder");
    }

    public void delete(String rel) throws IOException {
        File f = resolve(rel);
        if (!f.exists()) return;
        deleteRec(f);
        if (f.exists()) throw new IOException("cannot delete");
    }

    private void deleteRec(File f) {
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteRec(c);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    public void rename(String rel, String newName) throws IOException {
        if (newName == null) throw new IOException("no name");
        newName = newName.replace('/', '_').replace('\\', '_').replace(':', '_').trim();
        if (newName.isEmpty() || newName.equals(".") || newName.equals("..")) throw new IOException("bad name");
        File f = resolve(rel);
        File target = new File(f.getParentFile(), newName);
        if (target.exists()) throw new IOException("target already exists");
        if (!f.renameTo(target)) throw new IOException("rename failed");
    }

    /** Move a file or directory to another path inside the sandbox. */
    public void move(String fromRel, String toRel) throws IOException {
        File from = resolve(fromRel);
        File to = resolve(toRel);
        if (!from.exists()) throw new IOException("source not found");
        if (to.exists()) throw new IOException("target already exists");
        File parent = to.getParentFile();
        if (parent != null) //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        if (!from.renameTo(to)) {
            try (InputStream in = new FileInputStream(from);
                 OutputStream out = new FileOutputStream(to)) {
                copyStream(in, out, 4L * 1024 * 1024 * 1024);
            }
            deleteRec(from);
        }
    }

    /** Unzip an archive (world .zip/.mcworld, .mcpack, plugin archive) into dest dir. */
    public int unzip(String zipRel, String destRel) throws IOException {
        File zip = resolve(zipRel);
        File dest = resolve(destRel);
        if (!dest.exists() && !dest.mkdirs()) throw new IOException("cannot create dest");
        int count = 0;
        long total = 0;
        String destRoot = dest.getCanonicalPath();
        try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip), 1 << 16))) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                String name = e.getName();
                if (name.startsWith("__MACOSX") || name.contains("..")) continue;
                File out = new File(dest, name);
                String op = out.getCanonicalPath();
                if (!op.equals(destRoot) && !op.startsWith(destRoot + File.separator)) continue;
                if (e.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    out.mkdirs();
                } else {
                    File p = out.getParentFile();
                    if (p != null) //noinspection ResultOfMethodCallIgnored
                        p.mkdirs();
                    try (FileOutputStream fo = new FileOutputStream(out)) {
                        total += copyStream(zin, fo, 2L * 1024 * 1024 * 1024);
                    }
                    count++;
                    if (count > 30000) throw new IOException("archive has too many files");
                }
                zin.closeEntry();
            }
        }
        return count;
    }

    private long copyStream(InputStream in, OutputStream out, long max) throws IOException {
        byte[] buf = new byte[65536];
        long total = 0;
        int r;
        while ((r = in.read(buf)) > 0) {
            out.write(buf, 0, r);
            total += r;
            if (total > max) throw new IOException("stream too large");
        }
        return total;
    }

    /** Read the last maxBytes of a file as text (for log tailing). */
    public String tailText(String rel, int maxBytes) throws IOException {
        File f = resolve(rel);
        if (!f.isFile()) throw new IOException("file not found");
        long len = f.length();
        long start = Math.max(0, len - maxBytes);
        int n = (int) (len - start);
        byte[] buf = new byte[n];
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            raf.seek(start);
            raf.readFully(buf);
        }
        return new String(buf, StandardCharsets.UTF_8);
    }

    public JSONObject listLogs() throws IOException, JSONException {
        File dir = new File(root, "logs");
        JSONArray arr = new JSONArray();
        File[] files = dir.listFiles();
        if (files != null) {
            Arrays.sort(files, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
            for (File f : files) {
                if (!f.isFile()) continue;
                JSONObject o = new JSONObject();
                o.put("name", f.getName());
                o.put("size", f.length());
                o.put("mtime", f.lastModified());
                arr.put(o);
            }
        }
        JSONObject res = new JSONObject();
        res.put("entries", arr);
        return res;
    }

    public void deleteLog(String name) throws IOException {
        File dir = new File(root, "logs");
        File f = new File(dir, name);
        String dp = dir.getCanonicalPath();
        String fp = f.getCanonicalPath();
        if (!fp.startsWith(dp + File.separator)) throw new IOException("bad name");
        if (f.exists() && !f.delete()) throw new IOException("cannot delete");
    }

    public void clearLogs() throws IOException {
        File dir = new File(root, "logs");
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }

    /** Create a backup zip of server data (worlds, plugins, configs) at dest. */
    public long createBackup(File outFile) throws IOException {
        try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(outFile))) {
            zos.setLevel(6);
            zipRec(root, "", zos);
        }
        return outFile.length();
    }

    private void zipRec(File dir, String prefix, ZipOutputStream zos) throws IOException {
        File[] children = dir.listFiles();
        if (children == null) return;
        Arrays.sort(children, Comparable::compareTo);
        for (File c : children) {
            String base = prefix.isEmpty() ? c.getName() : prefix + "/" + c.getName();
            if (c.isDirectory()) {
                if (prefix.isEmpty() && BACKUP_EXCLUDE_DIRS.contains(c.getName())) continue;
                if (c.getName().startsWith(".") && c.getName().endsWith(".tmp")) continue;
                zos.putNextEntry(new ZipEntry(base + "/"));
                zos.closeEntry();
                zipRec(c, base, zos);
            } else {
                if (prefix.isEmpty() && BACKUP_EXCLUDE_FILES.contains(c.getName())) continue;
                if (c.getName().startsWith(".")) continue;
                if (c.getName().equals("server.lock")) continue;
                zos.putNextEntry(new ZipEntry(base));
                try (FileInputStream in = new FileInputStream(c)) {
                    copyStream(in, zos, 4L * 1024 * 1024 * 1024);
                }
                zos.closeEntry();
            }
        }
    }

    /** Restore a backup zip: wipes restorable content, then extracts. Returns entry count. */
    public int restoreBackup(File zip) throws IOException {
        // wipe current restorable state
        File[] children = root.listFiles();
        if (children != null) {
            for (File c : children) {
                if (c.isDirectory() && BACKUP_EXCLUDE_DIRS.contains(c.getName())) continue;
                if (c.isFile() && BACKUP_EXCLUDE_FILES.contains(c.getName())) continue;
                deleteRec(c);
            }
        }
        return unzipAbsolute(zip, root);
    }

    private int unzipAbsolute(File zip, File dest) throws IOException {
        int count = 0;
        long total = 0;
        String destRoot = dest.getCanonicalPath();
        try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip), 1 << 16))) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                String name = e.getName();
                if (name.startsWith("__MACOSX") || name.contains("..")) continue;
                File out = new File(dest, name);
                String op = out.getCanonicalPath();
                if (!op.equals(destRoot) && !op.startsWith(destRoot + File.separator)) continue;
                if (e.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    out.mkdirs();
                } else {
                    File p = out.getParentFile();
                    if (p != null) //noinspection ResultOfMethodCallIgnored
                        p.mkdirs();
                    try (FileOutputStream fo = new FileOutputStream(out)) {
                        total += copyStream(zin, fo, 4L * 1024 * 1024 * 1024);
                    }
                    count++;
                }
                zin.closeEntry();
            }
        }
        return count;
    }

    /** server.properties parsing: returns ordered array of {type:"c"|"k", text, key, value}. */
    public JSONArray readProperties(String rel) throws IOException, JSONException {
        File f = resolve(rel);
        JSONArray arr = new JSONArray();
        if (!f.isFile()) return arr;
        String content = tailText(rel, 1 << 20);
        for (String line : content.split("\n", -1)) {
            line = line.replaceFirst("\r$", "");
            JSONObject o = new JSONObject();
            String t = line.trim();
            if (t.isEmpty() || t.startsWith("#") || t.startsWith("!")) {
                o.put("type", "c");
                o.put("text", line);
            } else {
                int eq = line.indexOf('=');
                if (eq < 0) {
                    o.put("type", "c");
                    o.put("text", line);
                } else {
                    o.put("type", "k");
                    o.put("key", line.substring(0, eq).trim());
                    o.put("value", line.substring(eq + 1));
                }
            }
            arr.put(o);
        }
        return arr;
    }

    public void writeProperties(String rel, JSONArray lines) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < lines.length(); i++) {
            JSONObject o = lines.optJSONObject(i);
            if (o == null) continue;
            String type = o.optString("type", "c");
            if ("k".equals(type)) {
                sb.append(o.optString("key")).append('=').append(o.optString("value"));
            } else {
                sb.append(o.optString("text"));
            }
            sb.append('\n');
        }
        writeText(rel, sb.toString());
    }

    public List<File> listTopDirs() {
        List<File> out = new ArrayList<>();
        File[] children = root.listFiles();
        if (children != null) for (File c : children) out.add(c);
        return out;
    }
}
