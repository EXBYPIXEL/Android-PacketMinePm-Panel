package com.pmpanel.app;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Minimal RCON (Source RCON protocol) client.
 * Used by the Fake Players tool to drive a REMOTE server that has
 * rcon.enabled=on in server.properties (e.g. a public host).
 * PocketMine-MP ships RCON out of the box, so no extra plugin is needed
 * beyond PMPanelBot on the remote side.
 */
public final class RconClient {

    private static final int TYPE_AUTH = 3;
    private static final int TYPE_COMMAND = 2;

    private RconClient() {
    }

    /** One-shot: connect, authenticate, run one command, return its text output. */
    public static String exec(String host, int port, String password, String command, int timeoutMs) throws IOException {
        try (Socket sock = new Socket()) {
            sock.connect(new InetSocketAddress(host, port), timeoutMs);
            sock.setSoTimeout(timeoutMs);
            DataOutputStream out = new DataOutputStream(new BufferedOutputStream(sock.getOutputStream()));
            DataInputStream in = new DataInputStream(new BufferedInputStream(sock.getInputStream()));

            send(out, 42, TYPE_AUTH, password);
            Packet p = readAuth(in);
            if (p == null || p.id == -1) {
                throw new IOException("rcon authentication failed (wrong password?)");
            }

            send(out, 43, TYPE_COMMAND, command);
            p = readUntil(in, 43);
            if (p == null) throw new IOException("no response from rcon server");
            return p.body;
        }
    }

    private static void send(DataOutputStream out, int id, int type, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        int len = 4 + 4 + 4 + b.length + 2;
        out.writeInt(len);
        out.writeInt(id);
        out.writeInt(type);
        out.write(b);
        out.write(0);
        out.write(0);
        out.flush();
    }

    private static final class Packet {
        final int id;
        final int type;
        final String body;

        Packet(int id, int type, String body) {
            this.id = id;
            this.type = type;
            this.body = body;
        }
    }

    private static Packet readPacket(DataInputStream in) throws IOException {
        int len;
        try {
            len = in.readInt();
        } catch (IOException e) {
            return null;
        }
        if (len < 10 || len > 65536) return null;
        byte[] data = new byte[len];
        in.readFully(data);
        int id = (data[0] & 0xff) | (data[1] & 0xff) << 8 | (data[2] & 0xff) << 16 | (data[3] & 0xff) << 24;
        int type = (data[4] & 0xff) | (data[5] & 0xff) << 8 | (data[6] & 0xff) << 16 | (data[7] & 0xff) << 24;
        String body = new String(data, 12, len - 10, StandardCharsets.UTF_8);
        return new Packet(id, type, body);
    }

    /** Some servers answer AUTH with an extra empty value packet first. */
    private static Packet readAuth(DataInputStream in) throws IOException {
        for (int i = 0; i < 3; i++) {
            Packet p = readPacket(in);
            if (p == null) return null;
            if (p.type == TYPE_COMMAND || p.id == -1) return p;
        }
        return null;
    }

    private static Packet readUntil(DataInputStream in, int requestId) throws IOException {
        Packet last = null;
        for (int i = 0; i < 4; i++) {
            Packet p = readPacket(in);
            if (p == null) return last;
            last = p;
            if (p.id == requestId || p.id == -1) return p;
        }
        return last;
    }
}
