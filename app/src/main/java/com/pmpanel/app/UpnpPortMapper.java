package com.pmpanel.app;

import org.json.JSONObject;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.MulticastSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import javax.xml.parsers.DocumentBuilderFactory;

/**
 * Minimal UPnP IGD client (SSDP discovery + WANIPConnection/WANPPPConnection
 * SOAP actions) used by the Public IP tool to open the server's UDP port on
 * the home router automatically.
 *
 * Deliberately dependency-free: SSDP multicast + tiny XML parsing, all with
 * short timeouts so the UI never hangs on a router that ignores us.
 */
public final class UpnpPortMapper {

    private static final String SSDP_ADDR = "239.255.255.250";
    private static final int SSDP_PORT = 1900;
    private static final int DISCOVER_MS = 4000;
    private static final int HTTP_TIMEOUT = 6000;

    private UpnpPortMapper() {
    }

    public static class Gateway {
        public String location;   // description XML URL
        public String controlUrl; // full control URL
        public String serviceType;
        public String externalIp; // via GetExternalIPAddress ("" if refused)

        public String base() {
            try {
                URL u = new URL(location);
                String path = u.getPath();
                if (path == null || path.isEmpty()) path = "/";
                return u.getProtocol() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
            } catch (Exception e) {
                return "";
            }
        }
    }

    /**
     * Try to forward externalPort/udp to this device. Returns a JSON payload:
     * {ok, mapped, externalIp, gateway, error?, detail?}
     */
    public static JSONObject mapPort(int port, String localIp) {
        List<Gateway> gateways = discover();
        if (gateways.isEmpty()) {
            return result(false, null, null, "no UPnP gateway found on this network (router has no UPnP or it is disabled)");
        }
        String lastErr = null;
        for (Gateway g : gateways) {
            if (g.controlUrl == null || g.controlUrl.isEmpty()) continue;
            String err = soapAction(g, "AddPortMapping",
                    "<NewRemoteHost></NewRemoteHost>"
                    + "<NewExternalPort>" + port + "</NewExternalPort>"
                    + "<NewProtocol>UDP</NewProtocol>"
                    + "<NewInternalPort>" + port + "</NewInternalPort>"
                    + "<NewInternalClient>" + (localIp == null || localIp.isEmpty() ? "" : localIp) + "</NewInternalClient>"
                    + "<NewEnabled>1</NewEnabled>"
                    + "<NewPortMappingDescription>PMPanel Server</NewPortMappingDescription>"
                    + "<NewLeaseDuration>0</NewLeaseDuration>");
            if (err == null) {
                g.externalIp = fetchExternalIp(g);
                return result(true, g, null, null);
            }
            lastErr = err;
        }
        return result(false, gateways.get(0), lastErr, null);
    }

    /** Best-effort removal of the mapping we created. */
    public static void unmapPort(int port) {
        try {
            List<Gateway> gateways = discover();
            for (Gateway g : gateways) {
                if (g.controlUrl == null || g.controlUrl.isEmpty()) continue;
                soapAction(g, "DeletePortMapping",
                        "<NewRemoteHost></NewRemoteHost>"
                        + "<NewExternalPort>" + port + "</NewExternalPort>"
                        + "<NewProtocol>UDP</NewProtocol>");
            }
        } catch (Throwable ignored) {
        }
    }

    // ------------------------------------------------------------------

    private static JSONObject result(boolean mapped, Gateway g, String err, String detail) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("mapped", mapped);
            if (g != null) {
                if (g.externalIp != null && !g.externalIp.isEmpty()) o.put("externalIp", g.externalIp);
                try {
                    String host = new URL(g.location).getHost();
                    o.put("gateway", host);
                } catch (Exception ignored) {
                }
            }
            if (err != null) o.put("error", err);
            if (detail != null) o.put("detail", detail);
        } catch (Throwable ignored) {
        }
        return o;
    }

    /** SSDP M-SEARCH for InternetGatewayDevice, then resolve the control URL. */
    private static List<Gateway> discover() {
        List<Gateway> out = new ArrayList<>();
        try {
            byte[] req = ("M-SEARCH * HTTP/1.1\r\n"
                    + "HOST: " + SSDP_ADDR + ":" + SSDP_PORT + "\r\n"
                    + "MAN: \"ssdp:discover\"\r\n"
                    + "MX: 2\r\n"
                    + "ST: ssdp:all\r\n"
                    + "\r\n").getBytes(StandardCharsets.US_ASCII);
            MulticastSocket sock = new MulticastSocket();
            sock.setSoTimeout(DISCOVER_MS);
            try {
                sock.joinGroup(InetAddress.getByName(SSDP_ADDR));
            } catch (Throwable ignored) {
            }
            sock.send(new DatagramPacket(req, req.length, InetAddress.getByName(SSDP_ADDR), SSDP_PORT));
            byte[] buf = new byte[2048];
            long deadline = System.currentTimeMillis() + DISCOVER_MS;
            List<String> locations = new ArrayList<>();
            while (System.currentTimeMillis() < deadline && locations.size() < 6) {
                try {
                    DatagramPacket dp = new DatagramPacket(buf, buf.length);
                    sock.receive(dp);
                    String resp = new String(dp.getData(), dp.getOffset(), dp.getLength(), StandardCharsets.US_ASCII);
                    String loc = headerField(resp, "LOCATION");
                    if (loc != null && !locations.contains(loc)) {
                        // keep only gateway devices (service container in description)
                        if (headerField(resp, "ST") != null || resp.startsWith("HTTP/")) locations.add(loc);
                    }
                } catch (java.net.SocketTimeoutException e) {
                    break;
                }
            }
            sock.close();
            for (String loc : locations) {
                Gateway g = describe(loc);
                if (g != null) out.add(g);
            }
        } catch (Throwable ignored) {
        }
        return out;
    }

    private static String headerField(String resp, String field) {
        for (String line : resp.split("\r\n|\n")) {
            int c = line.indexOf(':');
            if (c > 0 && line.substring(0, c).trim().equalsIgnoreCase(field)) {
                return line.substring(c + 1).trim();
            }
        }
        return null;
    }

    /** Download the device description XML and extract a WANIP/WANPPP control URL. */
    private static Gateway describe(String location) {
        try {
            byte[] xml = http(location, "GET", null, null);
            if (xml == null) return null;
            Document doc = parse(xml);
            Gateway g = new Gateway();
            g.location = location;

            // Prefer WANIPConnection, then WANPPPConnection
            for (String st : new String[]{"WANIPConnection:2", "WANIPConnection:1", "WANPPPConnection:1"}) {
                String control = findServiceControl(doc, "urn:schemas-upnp-org:service:" + st);
                if (control != null) {
                    g.serviceType = "urn:schemas-upnp-org:service:" + st;
                    g.controlUrl = absolutize(g.base(), control);
                    return g;
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static String findServiceControl(Document doc, String serviceType) {
        try {
            NodeList services = doc.getElementsByTagName("service");
            for (int i = 0; i < services.getLength(); i++) {
                Element s = (Element) services.item(i);
                String st = textOf(s, "serviceType");
                String cu = textOf(s, "controlURL");
                if (st != null && st.trim().equals(serviceType) && cu != null && !cu.trim().isEmpty()) {
                    return cu.trim();
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static String textOf(Element parent, String tag) {
        NodeList nl = parent.getElementsByTagName(tag);
        if (nl.getLength() > 0 && nl.item(0).getFirstChild() != null) {
            return nl.item(0).getFirstChild().getNodeValue();
        }
        return null;
    }

    private static Document parse(byte[] xml) throws Exception {
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setNamespaceAware(false);
        try {
            f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        } catch (Throwable ignored) {
        }
        return f.newDocumentBuilder().parse(new ByteArrayInputStream(xml));
    }

    private static String absolutize(String base, String path) {
        if (path == null) return null;
        path = path.trim();
        if (path.startsWith("http://") || path.startsWith("https://")) return path;
        if (!path.startsWith("/")) path = "/" + path;
        return base + path;
    }

    private static String fetchExternalIp(Gateway g) {
        String err = soapAction(g, "GetExternalIPAddress", "", true);
        if (err != null) return "";
        return g.externalIp == null ? "" : g.externalIp;
    }

    /**
     * Run a SOAP action against the gateway. Returns null on success
     * (with respTag parsed into g.externalIp when asked) or an error string.
     */
    private static String soapAction(Gateway g, String action, String args) {
        return soapAction(g, action, args, false);
    }

    private static String soapAction(Gateway g, String action, String args, boolean readIp) {
        try {
            String body = "<?xml version=\"1.0\"?>"
                    + "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
                    + "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">"
                    + "<s:Body>"
                    + "<u:" + action + " xmlns:u=\"" + g.serviceType + "\">"
                    + args
                    + "</u:" + action + ">"
                    + "</s:Body></s:Envelope>";
            byte[] resp = http(g.controlUrl, "POST", body,
                    "\"" + g.serviceType + "#" + action + "\"");
            if (resp == null) return "router did not respond to " + action;
            String s = new String(resp, StandardCharsets.UTF_8);
            if (readIp) {
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("<NewExternalIPAddress>([^<]+)</NewExternalIPAddress>").matcher(s);
                if (m.find()) g.externalIp = m.group(1).trim();
                return null;
            }
            if (s.contains("<u:" + action + "Response")) return null; // success
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("<errorDescription>([^<]+)</errorDescription>").matcher(s);
            String desc = m.find() ? m.group(1) : "router refused the mapping";
            return desc;
        } catch (Throwable t) {
            return Bridge.safeMsg(t);
        }
    }

    private static byte[] http(String urlStr, String method, String body, String soapAction) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(HTTP_TIMEOUT);
            conn.setReadTimeout(HTTP_TIMEOUT);
            conn.setRequestMethod(method);
            if (soapAction != null) {
                conn.setRequestProperty("SOAPACTION", soapAction);
                conn.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"");
                conn.setDoOutput(true);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write((body == null ? "" : body).getBytes(StandardCharsets.UTF_8));
                }
            }
            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in == null) return null;
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            return bos.toByteArray();
        } catch (Throwable t) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
