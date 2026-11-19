package com.pmpanel.app;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Reads metadata out of PocketMine content files without running PHP:
 *  - plugin.yml inside .phar plugin archives (custom phar manifest parser)
 *  - plugin.yml inside .zip plugins / source directories
 *  - manifest.json inside resource pack .mcpack/.zip / directories
 *  - levelname.txt inside world folders
 *
 * The phar manifest layout was validated against the bundled PocketMine-MP.phar:
 *   stub ending in "__HALT_COMPILER();" [optional "?>" + whitespace]
 *   manifest: u32 len (NOT counting its own 4 bytes) | u32 numfiles | 2B api |
 *             u32 flags | u32 aliasLen | alias | u32 metaLen | meta
 *   per entry: u32 nameLen | name | u32 usize | u32 ts | u32 csize | u32 crc |
 *              u32 flags | u32 metaLen | meta
 *   file data follows the manifest sequentially; compression flag 0x1000 = raw DEFLATE.
 */
public final class PharMeta {

    private static final int MAX_FILE = 512 * 1024 * 1024; // 512 MB cap (not read fully anymore)
    private static final int MAX_ENTRY_SIZE = 2 * 1024 * 1024; // metadata files are tiny
    private static final int MAX_MANIFEST = 24 * 1024 * 1024; // phar manifest region cap

    private PharMeta() {
    }

    /* ================= public API ================= */

    /** Parse plugin metadata from a .phar, .zip or plugin source directory. */
    public static JSONObject pluginMeta(File f) {
        JSONObject o = new JSONObject();
        try {
            String lower = f.getName().toLowerCase(Locale.US);
            byte[] raw;
            if (f.isDirectory()) {
                File py = new File(f, "plugin.yml");
                if (!py.isFile()) throw new IOException("no plugin.yml");
                raw = Fs.readBytes(py, MAX_ENTRY_SIZE);
            } else if (lower.endsWith(".phar")) {
                raw = readFromPhar(f, "plugin.yml");
            } else if (lower.endsWith(".zip")) {
                raw = readFromZip(f, "plugin.yml");
            } else {
                throw new IOException("unsupported plugin format");
            }
            Map<String, String> yml = parseFlatYaml(new String(raw, StandardCharsets.UTF_8));
            putIf(o, "name", yml.get("name"));
            putIf(o, "version", yml.get("version"));
            putIf(o, "author", yml.get("author"));
            putIf(o, "description", yml.get("description"));
            putIf(o, "api", yml.get("api"));
            putIf(o, "main", yml.get("main"));
            putIf(o, "website", yml.get("website"));
            o.put("valid", o.has("name") && o.has("version"));
        } catch (Exception e) {
            o = ServerManager.JO("valid", false, "error", Bridge.safeMsg(e));
        }
        return o;
    }

    /** Parse resource pack manifest.json from a .mcpack/.zip or directory. */
    public static JSONObject packMeta(File f) {
        JSONObject o = new JSONObject();
        try {
            String lower = f.getName().toLowerCase(Locale.US);
            byte[] raw;
            if (f.isDirectory()) {
                File m = new File(f, "manifest.json");
                if (!m.isFile()) throw new IOException("no manifest.json");
                raw = Fs.readBytes(m, MAX_ENTRY_SIZE);
            } else if (lower.endsWith(".mcpack") || lower.endsWith(".zip")) {
                raw = readFromZip(f, "manifest.json");
            } else {
                throw new IOException("unsupported pack format");
            }
            JSONObject json = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            JSONObject header = json.optJSONObject("header");
            if (header == null) throw new IOException("no header in manifest");
            StringBuilder ver = new StringBuilder();
            org.json.JSONArray v = header.optJSONArray("version");
            if (v != null) {
                for (int i = 0; i < v.length(); i++) {
                    if (i > 0) ver.append('.');
                    ver.append(v.opt(i));
                }
            }
            putIf(o, "name", header.optString("name", null));
            putIf(o, "version", ver.length() > 0 ? ver.toString() : null);
            putIf(o, "uuid", header.optString("uuid", null));
            putIf(o, "minEngine", header.optString("min_engine_version", null));
            o.put("valid", o.has("name"));
        } catch (Exception e) {
            o = ServerManager.JO("valid", false, "error", Bridge.safeMsg(e));
        }
        return o;
    }

    /** World display name from levelname.txt (fallback: folder name). */
    public static String worldName(File worldDir) {
        try {
            File ln = new File(worldDir, "levelname.txt");
            if (ln.isFile()) {
                String s = new String(Fs.readBytes(ln, 4096), StandardCharsets.UTF_8);
                s = s.replace("\u0000", "").trim();
                if (!s.isEmpty()) return s;
            }
        } catch (Exception ignored) {
        }
        return worldDir.getName();
    }

    /* ================= phar parsing ================= */

    /**
     * Extract a small metadata file from inside a phar WITHOUT loading the whole
     * archive into memory. The old implementation read the entire phar into a
     * byte[] first, which throws OutOfMemoryError on low-RAM devices for large
     * plugins and surfaced as the generic WebView error
     * "Java exception was raised during method invocation".
     * Memory usage here is bounded to (stub head 256 KB + manifest region + entry <= 2 MB).
     */
    private static byte[] readFromPhar(File phar, String wanted) throws IOException {
        if (phar.length() > MAX_FILE) throw new IOException("phar too large");
        RandomAccessFile raf = new RandomAccessFile(phar, "r");
        try {
            long fileLen = raf.length();

            // 1) read only the head of the file to locate the stub end
            int headLen = (int) Math.min(fileLen, 262144);
            byte[] head = new byte[headLen];
            raf.seek(0);
            raf.readFully(head);
            int halt = indexOf(head, b("__HALT_COMPILER()"), 0, headLen);
            if (halt < 0) throw new IOException("not a phar (no halt stub)");
            int semi = halt;
            while (semi < headLen && head[semi] != ';') {
                if (head[semi] == '\u001b' || head[semi] == 0) throw new IOException("bad stub");
                semi++;
            }
            if (semi >= headLen) throw new IOException("bad phar stub");

            // 2) try each manifest start offset right after the ';'
            IOException last = null;
            boolean sawValidManifest = false;
            for (int off = semi + 1; off <= Math.min(semi + 24, headLen - 8); off++) {
                try {
                    byte[] out = tryManifest(raf, fileLen, off, wanted);
                    sawValidManifest = true;
                    if (out != null) return out;
                    last = new IOException("phar entry not found: " + wanted);
                } catch (IOException e) {
                    if (!sawValidManifest) last = e;
                }
            }
            throw last != null ? last : new IOException("no valid phar manifest");
        } finally {
            try {
                raf.close();
            } catch (IOException ignored) {
            }
        }
    }

    /**
     * Parse the manifest at 'start' (via RAF), return wanted entry's bytes or null.
     * Layout (validated against the bundled PocketMine-MP.phar):
     *   [start]      u32 manifestLen  (not counting its own 4 bytes)
     *   [start+4]    u32 numFiles
     *   [start+8]    u16 apiVersion | u32 globalFlags | u32 aliasLen | alias |
     *                u32 metaLen | meta | entries...
     * The entry walk must end exactly at start + 4 + manifestLen (= data region).
     */
    private static byte[] tryManifest(RandomAccessFile raf, long fileLen, int start, String wanted) throws IOException {
        // header: u32 manifestLen | u32 numFiles ...
        byte[] hdr = new byte[8];
        raf.seek(start);
        raf.readFully(hdr);
        long manifestLen = u32(hdr, 0);
        long numFiles = u32(hdr, 4);
        if (numFiles < 1 || numFiles > 300000) throw new IOException("bad numfiles");
        if (manifestLen < 8 || manifestLen > MAX_MANIFEST) throw new IOException("bad manifest len");
        long regionLen = manifestLen + 4; // includes the leading length field itself
        if (start + regionLen > fileLen) throw new IOException("bad manifest len");

        // read the whole manifest region into memory (bounded by MAX_MANIFEST)
        int manLen = (int) regionLen;
        byte[] man = new byte[manLen];
        raf.seek(start);
        raf.readFully(man);
        long manifestEnd = start + regionLen; // file data starts here

        int pos = 8;
        pos += 2;  // api version
        pos += 4;  // global flags
        if (pos + 4 > manLen) throw new IOException("truncated manifest");
        long aliasLen = u32(man, pos);
        pos += 4 + (int) aliasLen;
        if (pos < 0 || pos + 4 > manLen) throw new IOException("bad alias len");
        long metaLen = u32(man, pos);
        pos += 4 + (int) metaLen;
        if (metaLen < 0 || pos < 0 || pos > manLen) throw new IOException("bad meta len");

        long cursor = manifestEnd; // file data starts right after the manifest
        for (long i = 0; i < numFiles; i++) {
            if (pos + 4 > manLen) throw new IOException("truncated manifest");
            long nameLen = u32(man, pos);
            if (nameLen < 1 || nameLen > 4096) throw new IOException("bad entry name len");
            pos += 4;
            int nameStart = pos;
            pos += (int) nameLen;
            if (pos + 24 > manLen) throw new IOException("truncated manifest");
            long usize = u32(man, pos);
            long csize = u32(man, pos + 8);
            long eflags = u32(man, pos + 16);
            long eMetaLen = u32(man, pos + 20);
            pos += 24 + (int) eMetaLen;
            if (eMetaLen < 0 || pos > manLen) throw new IOException("bad entry meta");

            if (nameLen == wanted.length()) {
                boolean match = true;
                for (int k = 0; k < nameLen; k++) {
                    if (man[nameStart + k] != (byte) wanted.charAt(k)) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    if (usize > MAX_ENTRY_SIZE || csize > MAX_ENTRY_SIZE) throw new IOException("entry too large");
                    if (cursor < 0 || cursor + csize > fileLen) throw new IOException("content offset out of range");
                    byte[] raw = new byte[(int) Math.max(csize, 0)];
                    raf.seek(cursor);
                    raf.readFully(raw);
                    if ((eflags & 0xF000) != 0) {
                        if ((eflags & 0x2000) != 0) throw new IOException("bz2 entry unsupported");
                        raw = inflateRaw(raw, (int) usize);
                    }
                    return raw;
                }
            }
            cursor += csize;
            if (cursor > fileLen) throw new IOException("content offset out of range");
        }
        if (pos != manLen) throw new IOException("manifest walk mismatch");
        return null;
    }

    /* ================= zip parsing ================= */

    private static byte[] readFromZip(File zip, String wanted) throws IOException {
        try (ZipFile zf = new ZipFile(zip)) {
            // exact match first, then any path ending with /wanted
            ZipEntry e = zf.getEntry(wanted);
            if (e == null) {
                java.util.Enumeration<? extends ZipEntry> en = zf.entries();
                while (en.hasMoreElements()) {
                    ZipEntry z = en.nextElement();
                    String n = z.getName();
                    if (!z.isDirectory() && (n.equals(wanted) || n.endsWith("/" + wanted))) {
                        e = z;
                        break;
                    }
                }
            }
            if (e == null) throw new IOException(wanted + " not found in zip");
            if (e.getSize() > MAX_ENTRY_SIZE) throw new IOException("entry too large");
            try (InputStream in = zf.getInputStream(e)) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int r;
                while ((r = in.read(buf)) > 0) {
                    bos.write(buf, 0, r);
                    if (bos.size() > MAX_ENTRY_SIZE) throw new IOException("entry too large");
                }
                return bos.toByteArray();
            }
        }
    }

    /* ================= tiny YAML subset ================= */

    /** Parse top-level flat "key: value" lines (enough for plugin.yml headers). */
    private static Map<String, String> parseFlatYaml(String content) {
        Map<String, String> out = new HashMap<>();
        for (String line : content.split("\n", 200)) {
            line = line.replace("\r", "");
            if (line.isEmpty() || line.startsWith("#")) continue;
            if (line.startsWith(" ") || line.startsWith("-") || line.startsWith("\t")) continue; // nested
            int c = line.indexOf(':');
            if (c <= 0 || c == line.length() - 1 && line.indexOf(':', c) != c) {
                // "key:" with nothing after -> skip
                if (c > 0 && c == line.length() - 1) out.putIfAbsent(line.substring(0, c).trim(), "");
                continue;
            }
            String k = line.substring(0, c).trim();
            String v = line.substring(c + 1).trim();
            if (v.isEmpty()) continue;
            // strip quotes
            if (v.length() >= 2 && ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'")))) {
                v = v.substring(1, v.length() - 1);
            }
            // list syntax [a, b] or inline comments
            if (v.startsWith("[")) {
                String inner = v.replaceAll("[\\[\\]]", "").trim();
                String[] parts = inner.split(",");
                StringBuilder sb = new StringBuilder();
                for (String p : parts) {
                    p = p.trim();
                    if (p.isEmpty()) continue;
                    if (p.length() >= 2 && (p.startsWith("\"") || p.startsWith("'"))) p = p.substring(1, p.length() - 1);
                    if (sb.length() > 0) sb.append(", ");
                    sb.append(p);
                }
                v = sb.toString();
            } else {
                int hash = v.indexOf(" #");
                if (hash > 0 && !v.startsWith("\"")) v = v.substring(0, hash).trim();
            }
            out.putIfAbsent(k, v);
        }
        return out;
    }

    /* ================= helpers ================= */

    private static void putIf(JSONObject o, String k, String v) {
        if (v != null && !v.isEmpty() && !"null".equals(v)) {
            try {
                o.put(k, v);
            } catch (Exception ignored) {
            }
        }
    }

    private static long u32(byte[] d, int off) {
        return (d[off] & 0xFFL) | (d[off + 1] & 0xFFL) << 8 | (d[off + 2] & 0xFFL) << 16 | (d[off + 3] & 0xFFL) << 24;
    }

    private static byte[] slice(byte[] d, long off, long len) throws IOException {
        if (off < 0 || len < 0 || off + len > d.length) throw new IOException("slice out of range");
        byte[] out = new byte[(int) len];
        System.arraycopy(d, (int) off, out, 0, (int) len);
        return out;
    }

    private static byte[] b(String s) {
        return s.getBytes(StandardCharsets.US_ASCII);
    }

    private static int indexOf(byte[] data, byte[] needle, int from, int limit) {
        int max = Math.min(data.length - needle.length, limit);
        for (int i = from; i <= max; i++) {
            boolean ok = true;
            for (int k = 0; k < needle.length; k++) {
                if (data[i + k] != needle[k]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return i;
        }
        return -1;
    }

    /** Raw DEFLATE decompression (phar GZ entries have no zlib header). */
    private static byte[] inflateRaw(byte[] in, int expected) throws IOException {
        java.util.zip.Inflater inf = new java.util.zip.Inflater(true);
        try {
            inf.setInput(in);
            byte[] out = new byte[Math.max(expected, 64)];
            int n = inf.inflate(out);
            if (n < expected && !inf.finished()) {
                // expected size lied; grow once
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                bos.write(out, 0, n);
                byte[] buf = new byte[8192];
                while (!inf.finished()) {
                    int r = inf.inflate(buf);
                    if (r == 0) break;
                    bos.write(buf, 0, r);
                }
                return bos.toByteArray();
            }
            byte[] res = new byte[n];
            System.arraycopy(out, 0, res, 0, n);
            return res;
        } catch (Exception e) {
            throw new IOException("inflate failed: " + e.getMessage());
        } finally {
            inf.end();
        }
    }
}
