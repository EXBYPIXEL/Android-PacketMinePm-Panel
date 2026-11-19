package com.pmpanel.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.CheckedOutputStream;
import java.util.zip.Deflater;
import java.util.zip.InflaterInputStream;

/**
 * Pure-Java PHAR archive writer/extractor for PocketMine plugins.
 *
 * Replaces the old approach of shelling out to the bundled PHP binary
 * (pmtools.php), which failed on real devices: ProcessBuilder cannot exec the
 * packed libpmphp.so on many phones ("error=2, No such file or directory") and
 * depends on a fully installed server. The format here mirrors byte-for-byte
 * what PHP itself writes (validated against the bundled PocketMine-MP.phar and
 * PMPanelBot.phar, and re-validated by opening the produced archives with the
 * bundled PHP 8.4 `Phar` class with phar.require_hash=1):
 *
 *   stub:  "<?php __HALT_COMPILER(); ?>\r\n"
 *   u32    manifest length (NOT counting its own 4 bytes)
 *   u32    number of files
 *   u16    api version            (0x0011 like PHP writes)
 *   u32    global flags           (0x00010000, same as both bundled phars)
 *   u32    alias length + alias   (phar file name)
 *   u32    global metadata length (0)
 *   per entry:
 *     u32 name length + name (forward slashes)
 *     u32 uncompressed size | u32 timestamp | u32 compressed size
 *     u32 CRC32 of uncompressed data | u32 flags | u32 metadata length (0)
 *   entry flags: 0x1B4 (perms 0664) | 0x1000 when raw-DEFLATE compressed
 *   file data follows sequentially in manifest order
 *   sha256(all previous bytes) | u32 signature type 3 | "GBMB"
 *
 * No Android imports on purpose: the class is unit-testable on the JVM host
 * (scripts/PharHostTest.java) against the real bundled phars.
 */
public final class Phar {

    private static final byte[] STUB = "<?php __HALT_COMPILER(); ?>\r\n"
            .getBytes(StandardCharsets.US_ASCII);
    private static final int SIG_TYPE_SHA256 = 3;
    private static final int API_VERSION = 0x0011;
    private static final int GLOBAL_FLAGS = 0x00010000;
    private static final int PERM_0664 = 0x1B4;
    private static final int FLAG_GZ = 0x1000;   // raw DEFLATE per entry
    private static final int FLAG_BZ2 = 0x2000;

    private static final int MAX_ENTRIES = 200000;
    private static final long MAX_ENTRY = 192L * 1024 * 1024;   // 192 MB per entry
    private static final long MAX_TOTAL = 768L * 1024 * 1024;   // 768 MB archive

    private Phar() {
    }

    /* ============================ writing ============================ */

    /** One source file with its archive-relative path. */
    private static class Entry {
        final String path;
        final File file;
        long usize, csize, crc, ts;
        int flags;

        Entry(String path, File file) {
            this.path = path;
            this.file = file;
        }
    }

    /**
     * Build a phar from a source folder.
     *
     * @param srcDir  folder whose contents become the archive root
     * @param outFile destination .phar (written via .part then renamed)
     * @param alias   phar alias (normally the output file name)
     * @return number of files packed
     */
    public static int write(File srcDir, File outFile, String alias) throws IOException {
        List<Entry> entries = new ArrayList<>();
        collect(srcDir, "", entries, 0);
        if (entries.isEmpty()) throw new IOException("no files found under " + srcDir.getName());
        Collections.sort(entries, new Comparator<Entry>() {
            public int compare(Entry a, Entry b) {
                return a.path.compareTo(b.path);
            }
        });

        File part = new File(outFile.getParentFile(), outFile.getName() + ".part");
        //noinspection ResultOfMethodCallIgnored
        part.getParentFile().mkdirs();
        MessageDigest sha;
        try {
            sha = MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IOException("no sha256: " + e);
        }

        // 1) manifest header + entry table (data must be laid out in the same order)
        ByteArrayOutputStream body = new ByteArrayOutputStream(64 * 1024);
        ByteArrayOutputStream data = new ByteArrayOutputStream(256 * 1024);
        long total = 0;
        byte[] aliasB = (alias == null ? "" : alias).getBytes(StandardCharsets.UTF_8);

        putU32(body, entries.size());
        putU16(body, API_VERSION);
        putU32(body, GLOBAL_FLAGS);
        putU32(body, aliasB.length);
        body.write(aliasB, 0, aliasB.length);
        putU32(body, 0); // global metadata length

        for (Entry e : entries) {
            byte[] name = e.path.getBytes(StandardCharsets.UTF_8);
            byte[] raw = readAll(e.file, MAX_ENTRY);
            e.usize = raw.length;
            e.crc = crc32(raw);
            e.ts = e.file.lastModified() / 1000L;

            byte[] packed = deflate(raw);
            boolean useDeflate = packed.length < raw.length;
            e.csize = useDeflate ? packed.length : raw.length;
            e.flags = PERM_0664 | (useDeflate ? FLAG_GZ : 0);

            putU32(body, name.length);
            body.write(name, 0, name.length);
            putU32(body, (int) e.usize);
            putU32(body, (int) Math.max(0, Math.min(Integer.MAX_VALUE, e.ts)));
            putU32(body, (int) e.csize);
            putU32(body, (int) e.crc);
            putU32(body, e.flags);
            putU32(body, 0); // entry metadata length

            data.write(useDeflate ? packed : raw, 0, (int) e.csize);
            total += e.csize;
            if (total > MAX_TOTAL) throw new IOException("plugin too large (over 768 MB)");
        }

        // 2) write file: stub | u32 manifestLen | manifest | data | signature
        DigestOutputStream out = new DigestOutputStream(new FileOutputStream(part), sha);
        try {
            out.write(STUB);
            putU32(out, body.size());
            body.writeTo(out);
            data.writeTo(out);
            byte[] sig = sha.digest();
            out.write(sig);
            putU32(out, SIG_TYPE_SHA256);
            out.write(new byte[]{'G', 'B', 'M', 'B'});
            out.flush();
        } finally {
            try {
                out.close();
            } catch (IOException ignored) {
            }
        }
        if (outFile.exists()) //noinspection ResultOfMethodCallIgnored
            outFile.delete();
        if (!part.renameTo(outFile)) throw new IOException("cannot finalize " + outFile.getName());
        return entries.size();
    }

    private static void collect(File dir, String prefix, List<Entry> out, int depth) {
        if (depth > 40) return;
        File[] kids = dir.listFiles();
        if (kids == null) return;
        List<File> sorted = new ArrayList<>();
        Collections.addAll(sorted, kids);
        Collections.sort(sorted, new Comparator<File>() {
            public int compare(File a, File b) {
                return a.getName().compareToIgnoreCase(b.getName());
            }
        });
        for (File f : sorted) {
            String p = prefix.isEmpty() ? f.getName() : prefix + "/" + f.getName();
            if (f.isDirectory()) {
                collect(f, p, out, depth + 1);
            } else if (f.isFile()) {
                out.add(new Entry(p, f));
            }
        }
    }

    /* ============================ reading ============================ */

    /** Extract a .phar into destDir. @return number of files extracted. */
    public static int extract(File phar, File destDir) throws IOException {
        RandomAccessFile raf = new RandomAccessFile(phar, "r");
        try {
            long fileLen = raf.length();
            int headLen = (int) Math.min(fileLen, 262144);
            byte[] head = new byte[headLen];
            raf.seek(0);
            raf.readFully(head);
            int halt = indexOf(head, b("__HALT_COMPILER()"), 0, headLen);
            if (halt < 0) throw new IOException("not a phar (no halt stub)");
            int semi = halt;
            while (semi < headLen && head[semi] != ';') semi++;
            if (semi >= headLen) throw new IOException("bad phar stub");

            IOException last = null;
            for (int off = semi + 1; off <= Math.min(semi + 24, headLen - 8); off++) {
                try {
                    return extractManifest(raf, fileLen, off, destDir);
                } catch (IOException e) {
                    last = e;
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

    private static int extractManifest(RandomAccessFile raf, long fileLen, int start,
                                       File destDir) throws IOException {
        byte[] hdr = new byte[8];
        raf.seek(start);
        raf.readFully(hdr);
        long manifestLen = u32(hdr, 0);
        long numFiles = u32(hdr, 4);
        if (numFiles < 1 || numFiles > MAX_ENTRIES) throw new IOException("bad numfiles");
        if (manifestLen < 8 || manifestLen > 64L * 1024 * 1024) throw new IOException("bad manifest len");
        long regionLen = manifestLen + 4;
        if (start + regionLen > fileLen) throw new IOException("bad manifest len");

        int manLen = (int) regionLen;
        byte[] man = new byte[manLen];
        raf.seek(start);
        raf.readFully(man);
        long manifestEnd = start + regionLen;

        int pos = 8;
        pos += 2; // api
        long gflags = u32(man, pos);
        pos += 4;
        if ((gflags & 0xF000) != 0) {
            throw new IOException("whole-archive compressed phar is not supported");
        }
        long aliasLen = u32(man, pos);
        pos += 4 + (int) aliasLen;
        if (aliasLen < 0 || pos < 0 || pos + 4 > manLen) throw new IOException("bad alias len");
        long metaLen = u32(man, pos);
        pos += 4 + (int) metaLen;
        if (metaLen < 0 || pos < 0 || pos > manLen) throw new IOException("bad meta len");

        //noinspection ResultOfMethodCallIgnored
        destDir.mkdirs();
        long cursor = manifestEnd;
        long total = 0;
        int written = 0;
        for (long i = 0; i < numFiles; i++) {
            if (pos + 4 > manLen) throw new IOException("truncated manifest");
            long nameLen = u32(man, pos);
            pos += 4;
            if (nameLen < 1 || nameLen > 4096) throw new IOException("bad entry name len");
            if (pos + nameLen > manLen) throw new IOException("truncated manifest");
            String name = new String(man, pos, (int) nameLen, StandardCharsets.UTF_8);
            pos += nameLen;
            if (pos + 24 > manLen) throw new IOException("truncated manifest");
            long usize = u32(man, pos);
            long ts = u32(man, pos + 4);
            long csize = u32(man, pos + 8);
            long crc = u32(man, pos + 12);
            long eflags = u32(man, pos + 16);
            long eMetaLen = u32(man, pos + 20);
            pos += 24 + (int) eMetaLen;
            if (eMetaLen < 0 || pos > manLen) throw new IOException("bad entry meta");
            if (usize > MAX_ENTRY || csize > MAX_ENTRY) throw new IOException("entry too large: " + name);
            if (cursor < 0 || cursor + csize > fileLen) throw new IOException("content offset out of range");
            total += usize;
            if (total > MAX_TOTAL) throw new IOException("phar too large to extract");

            File out = safeFile(destDir, name);
            //noinspection ResultOfMethodCallIgnored
            out.getParentFile().mkdirs();
            if ((eflags & FLAG_BZ2) != 0) throw new IOException("bz2 entry unsupported: " + name);
            boolean gz = (eflags & FLAG_GZ) != 0;

            CRC32 check = new CRC32();
            if (gz) {
                byte[] raw = new byte[(int) csize];
                raf.seek(cursor);
                raf.readFully(raw);
                InflaterInputStream in = new InflaterInputStream(
                        new java.io.ByteArrayInputStream(raw),
                        new java.util.zip.Inflater(true), 65536);
                try (CheckedOutputStream cout = new CheckedOutputStream(
                        new FileOutputStream(out), check)) {
                    copy(in, cout);
                } finally {
                    try {
                        in.close();
                    } catch (IOException ignored) {
                    }
                }
            } else {
                byte[] buf = new byte[65536];
                raf.seek(cursor);
                long left = csize;
                try (CheckedOutputStream cout = new CheckedOutputStream(
                        new FileOutputStream(out), check)) {
                    while (left > 0) {
                        int want = (int) Math.min(buf.length, left);
                        int r = raf.read(buf, 0, want);
                        if (r <= 0) throw new IOException("unexpected end of phar");
                        cout.write(buf, 0, r);
                        left -= r;
                    }
                }
            }
            if (check.getValue() != crc) {
                //noinspection ResultOfMethodCallIgnored
                new File(destDir, name).delete();
                throw new IOException("crc mismatch (corrupt phar?): " + name);
            }
            if (out.length() != usize) throw new IOException("size mismatch for " + name);
            //noinspection ResultOfMethodCallIgnored
            out.setLastModified(ts > 0 ? ts * 1000L : System.currentTimeMillis());
            cursor += csize;
            written++;
        }
        if (pos != manLen) throw new IOException("manifest walk mismatch");
        return written;
    }

    /* ============================ helpers ============================ */

    /** Resolve name under dir, refusing absolute paths and traversal. */
    private static File safeFile(File dir, String name) throws IOException {
        name = name.replace('\\', '/');
        if (name.startsWith("/") || name.contains("../") || name.equals("..")
                || name.indexOf('\0') >= 0) {
            throw new IOException("bad entry path: " + name);
        }
        File f = new File(dir, name);
        String rootPath = dir.getCanonicalPath();
        String fp = f.getCanonicalPath();
        if (!fp.startsWith(rootPath + File.separator)) {
            throw new IOException("entry escapes output dir: " + name);
        }
        return f;
    }

    private static byte[] readAll(File f, long max) throws IOException {
        long len = f.length();
        if (len > max) throw new IOException("file too large: " + f.getName());
        byte[] buf = new byte[(int) len];
        try (FileInputStream in = new FileInputStream(f)) {
            int off = 0;
            while (off < buf.length) {
                int r = in.read(buf, off, buf.length - off);
                if (r < 0) break;
                off += r;
            }
            if (off < buf.length) throw new IOException("short read: " + f.getName());
        }
        return buf;
    }

    private static byte[] deflate(byte[] raw) {
        Deflater def = new Deflater(Deflater.BEST_COMPRESSION, true);
        try {
            def.setInput(raw);
            def.finish();
            ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(64, raw.length / 2));
            byte[] buf = new byte[65536];
            while (!def.finished()) {
                int n = def.deflate(buf);
                if (n > 0) bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        } finally {
            def.end();
        }
    }

    private static void putU32(OutputStream out, long v) throws IOException {
        out.write((int) (v & 0xFF));
        out.write((int) ((v >>> 8) & 0xFF));
        out.write((int) ((v >>> 16) & 0xFF));
        out.write((int) ((v >>> 24) & 0xFF));
    }

    private static void putU16(OutputStream out, int v) throws IOException {
        out.write(v & 0xFF);
        out.write((v >>> 8) & 0xFF);
    }

    private static long crc32(byte[] data) {
        CRC32 c = new CRC32();
        c.update(data);
        return c.getValue();
    }

    private static long u32(byte[] d, int off) {
        return (d[off] & 0xFFL) | (d[off + 1] & 0xFFL) << 8
                | (d[off + 2] & 0xFFL) << 16 | (d[off + 3] & 0xFFL) << 24;
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

    private static void copy(java.io.InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[65536];
        int r;
        while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
    }

    /** OutputStream that also feeds every byte into a MessageDigest. */
    private static class DigestOutputStream extends OutputStream {
        private final OutputStream out;
        private final MessageDigest digest;

        DigestOutputStream(OutputStream out, MessageDigest digest) {
            this.out = out;
            this.digest = digest;
        }

        @Override
        public void write(int b) throws IOException {
            out.write(b);
            digest.update((byte) b);
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            out.write(b, off, len);
            digest.update(b, off, len);
        }

        @Override
        public void flush() throws IOException {
            out.flush();
        }

        @Override
        public void close() throws IOException {
            out.close();
        }
    }
}
