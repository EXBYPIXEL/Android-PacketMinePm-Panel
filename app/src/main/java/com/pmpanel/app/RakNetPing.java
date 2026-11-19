package com.pmpanel.app;

import org.json.JSONObject;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

/**
 * RakNet unconnected ping (the same packet the Minecraft client sends when
 * pinging a server in the friends list). Used by the Public IP tool to verify
 * that a server is alive and reachable at host:port, and to read its MOTD.
 */
public final class RakNetPing {

    private static final byte[] MAGIC = {
            (byte) 0x00, (byte) 0xff, (byte) 0xff, (byte) 0x00,
            (byte) 0xfe, (byte) 0xfe, (byte) 0xfe, (byte) 0xfe,
            (byte) 0xfd, (byte) 0xfd, (byte) 0xfd, (byte) 0xfd,
            0x12, 0x34, 0x56, 0x78
    };

    private RakNetPing() {
    }

    /**
     * @param timeoutMs total wait for the pong reply
     * @return {ok:true, motd, mcVersion, protocol, players, maxPlayers, latencyMs}
     */
    public static JSONObject ping(String host, int port, int timeoutMs) throws Exception {
        JSONObject o = new JSONObject();
        long t0 = System.currentTimeMillis();
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setSoTimeout(timeoutMs);
            ByteBuffer bb = ByteBuffer.allocate(1 + 8 + 16);
            bb.put((byte) 0x01);
            bb.putLong(t0);
            bb.put(MAGIC);
            InetAddress addr = InetAddress.getByName(host);
            DatagramPacket out = new DatagramPacket(bb.array(), bb.position(), addr, port);
            socket.send(out);

            byte[] buf = new byte[4096];
            DatagramPacket in = new DatagramPacket(buf, buf.length);
            socket.receive(in); // SocketTimeoutException -> unreachable
            long latency = System.currentTimeMillis() - t0;

            ByteBuffer r = ByteBuffer.wrap(buf, 0, in.getLength());
            byte id = r.get();
            if (id != (byte) 0x1c) throw new IOException("unexpected pong id " + (id & 0xff));
            r.getLong(); // ping time echo
            r.getLong(); // server guid
            byte[] magic = new byte[16];
            r.get(magic);
            short len = r.getShort();
            if (len < 0 || r.remaining() < len) throw new IOException("truncated pong");
            byte[] sdata = new byte[len];
            r.get(sdata);
            String info = new String(sdata, StandardCharsets.UTF_8);
            // "MCPE;MOTD;protocol;mcVersion;players;maxPlayers;uuid;subMotd;..."
            String[] parts = info.split(";", -1);
            o.put("motd", parts.length > 1 ? parts[1] : "");
            o.put("protocol", parts.length > 2 ? parts[2] : "");
            o.put("mcVersion", parts.length > 3 ? parts[3] : "");
            o.put("players", parts.length > 4 ? safeInt(parts[4]) : -1);
            o.put("maxPlayers", parts.length > 5 ? safeInt(parts[5]) : -1);
            o.put("latencyMs", latency);
            o.put("host", host + ":" + port);
            return o;
        }
    }

    private static int safeInt(String s) {
        try {
            return Integer.parseInt(s.trim());
        } catch (Exception e) {
            return -1;
        }
    }
}
