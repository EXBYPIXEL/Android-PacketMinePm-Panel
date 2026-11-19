package com.pmpanel.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * GameSpy4 (UT3) query client - the protocol PocketMine answers on the server
 * UDP port when "enable-query=on" (the bundled server.properties turns it on
 * by default). Used by the Statistics tool to get REAL live data from the
 * running server without touching its console: player list, plugin list,
 * engine version, map name, gamemode class, whitelist state, max players.
 *
 * Wire format mirrors pocketmine\network\query\QueryHandler (PM5):
 *  - handshake: FE FD 09 + sessionBE(4)  ->  09 + sessionBE(4) + tokenBE(4) + 00
 *  - stat:      FE FD 00 + sessionBE(4) + tokenBE(4) + 4 extra bytes
 *               ->  00 + sessionBE(4) + KV block + player block
 */
public final class QueryClient {

    private QueryClient() {
    }

    public static JSONObject query(String host, int port, int timeoutMs) throws Exception {
        byte[] session = {0x12, 0x34, (byte) 0xAB, (byte) 0xCD};
        try (DatagramSocket s = new DatagramSocket()) {
            s.setSoTimeout(timeoutMs);
            InetAddress addr = InetAddress.getByName(host);

            // ---- handshake ----
            byte[] hs = new byte[7];
            hs[0] = (byte) 0xFE; hs[1] = (byte) 0xFD; hs[2] = 0x09;
            System.arraycopy(session, 0, hs, 3, 4);
            byte[] hsResp = roundTrip(s, hs, addr, port);
            if (hsResp == null || hsResp.length < 7 || hsResp[0] != 0x09) {
                throw new SocketTimeoutException("no query handshake response");
            }
            /* PM5 answers: 09 + session(4) + <token as ASCII DECIMAL string> + 00.
             * The stat request must carry the value back as a 4-byte BE int. */
            int end = 5;
            while (end < hsResp.length && hsResp[end] != 0x00) end++;
            String tokStr = new String(hsResp, 5, end - 5, StandardCharsets.ISO_8859_1).trim();
            long tokenVal = Long.parseLong(tokStr);

            // ---- full stat ----
            byte[] stat = new byte[15];
            stat[0] = (byte) 0xFE; stat[1] = (byte) 0xFD; stat[2] = 0x00;
            System.arraycopy(session, 0, stat, 3, 4);
            stat[7] = (byte) ((tokenVal >> 24) & 0xFF);
            stat[8] = (byte) ((tokenVal >> 16) & 0xFF);
            stat[9] = (byte) ((tokenVal >> 8) & 0xFF);
            stat[10] = (byte) (tokenVal & 0xFF);
            stat[11] = (byte) 0xFF; stat[12] = (byte) 0xFF; stat[13] = (byte) 0xFF; stat[14] = 0x01;
            byte[] resp = roundTrip(s, stat, addr, port);
            if (resp == null || resp.length < 6 || resp[0] != 0x00) {
                throw new SocketTimeoutException("no query stat response");
            }
            return parseStat(resp);
        }
    }

    private static byte[] roundTrip(DatagramSocket s, byte[] out, InetAddress addr, int port)
            throws Exception {
        s.send(new DatagramPacket(out, out.length, addr, port));
        byte[] buf = new byte[16384];
        DatagramPacket in = new DatagramPacket(buf, buf.length);
        s.receive(in);
        return java.util.Arrays.copyOf(in.getData(), in.getLength());
    }

    /** Parse the long-query payload: 00 session(4) then "key\0value\0..." pairs,
     *  terminator "\x00\x01player_\x00\x00", then null-terminated player names. */
    private static JSONObject parseStat(byte[] p) {
        JSONObject o = new JSONObject();
        List<String> players = new ArrayList<>();
        try {
            String asText = new String(p, StandardCharsets.ISO_8859_1);
            int playerMark = asText.indexOf("\u0000\u0001player_\u0000\u0000");
            String kvPart;
            String plPart;
            if (playerMark >= 0) {
                kvPart = asText.substring(5, playerMark);
                plPart = asText.substring(playerMark + 10);
            } else {
                kvPart = asText.substring(5);
                plPart = "";
            }
            String[] tok = kvPart.split("\u0000", -1);
            for (int i = 0; i + 1 < tok.length; i += 2) {
                String k = tok[i];
                String v = tok[i + 1];
                if (k == null || k.isEmpty()) break;
                putKv(o, k, v);
            }
            if (!plPart.isEmpty()) {
                for (String name : plPart.split("\u0000", -1)) {
                    if (name.isEmpty()) continue;
                    // skip the "\u0001" marker byte if present
                    if (name.charAt(0) == '\u0001') name = name.substring(1);
                    if (!name.isEmpty()) players.add(name);
                }
            }
        } catch (Throwable ignored) {
        }
        try {
            o.put("players", new JSONArray(players));
            o.put("numplayers", players.size());
        } catch (Throwable ignored) {
        }
        return o;
    }

    private static void putKv(JSONObject o, String k, String v) {
        try {
            switch (k) {
                case "numplayers":
                case "maxplayers":
                    o.put(k, parseIntSafe(v));
                    break;
                case "hostport":
                    o.put("hostport", parseIntSafe(v));
                    break;
                default:
                    o.put(k, v);
            }
        } catch (Throwable ignored) {
        }
    }

    private static int parseIntSafe(String s) {
        try {
            return Integer.parseInt(s.trim());
        } catch (Throwable t) {
            return 0;
        }
    }
}
