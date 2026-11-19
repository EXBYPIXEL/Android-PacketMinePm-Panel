package com.pmpanel.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {

    static final int REQ_UPLOAD = 1;
    static final int REQ_SAVE = 2;
    static final int REQ_RESTORE = 3;
    static final int REQ_NOTIF = 10;

    private WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Bridge bridge;
    private static class PendingUpload {
        String reqId;
        String destDir;
        String profileId; // v2.7: uploads go into the SERVER the panel is driving
    }

    private static class PendingSave {
        String reqId;
        String path;
        String profileId; // v2.7: saves/exports read from the right server
    }

    private PendingUpload pendingUpload;
    private PendingSave pendingSave;
    private String pendingRestoreReqId;
    private String pendingRestoreProfile;

    @SuppressLint({"SetJavaScriptEnabled"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        try {
            web = new WebView(this);
        } catch (Throwable t) {
            // WebView provider missing/disabled on some devices - show a readable
            // message instead of crashing at launch.
            android.widget.LinearLayout box = new android.widget.LinearLayout(this);
            box.setOrientation(android.widget.LinearLayout.VERTICAL);
            box.setGravity(android.view.Gravity.CENTER);
            box.setBackgroundColor(0xFF05060A);
            android.widget.TextView tv = new android.widget.TextView(this);
            tv.setTextColor(0xFFFFFFFF);
            tv.setPadding(48, 48, 48, 48);
            tv.setText("WebView is not available on this device.\n\nPlease enable or update\n'Android System WebView'\nin Google Play and reopen the app.");
            box.addView(tv);
            setContentView(box);
            return;
        }
        setContentView(web);
        instanceWeb = web;
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.setBackgroundColor(0xFF05060A);
        web.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
                // persist uncaught JS errors so remote devices can share them
                if (cm != null && cm.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR
                        && cm.message() != null && cm.message().startsWith("Uncaught")) {
                    appendCrashLog("JS " + cm.message());
                }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url != null && url.startsWith("file://")) return false;
                try {
                    if (url != null && url.startsWith("https://")) {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    }
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        bridge = new Bridge(this);
        web.addJavascriptInterface(bridge, "PMPanel");
        web.loadUrl("file:///android_asset/www/index.html");

        requestNotifPermissionIfNeeded();
        applyKeepScreenOn();
    }

    public void applyKeepScreenOn() {
        if (web == null) return;
        boolean keep = Installer.prefs(this).getBoolean("keepScreenOn", false);
        web.setKeepScreenOn(keep);
    }

    private void requestNotifPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
            }
        }
    }

    public void requestIgnoreBatteryOptimizations() {
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            try {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception ignored) {
            }
        }
    }

    /** Push an asynchronous result event into the WebView. */
    public void pushEvent(String reqId, JSONObject payload) {
        if (reqId == null || reqId.isEmpty()) return;
        try {
            payload.put("reqId", reqId);
        } catch (Exception ignored) {
        }
        try {
            final String js = "window.__pmEvent && window.__pmEvent(" + payload.toString() + ")";
            main.post(() -> {
                try {
                    if (web != null) web.evaluateJavascript(js, null);
                } catch (Throwable ignored) {
                    // WebView already destroyed - nothing to deliver
                }
            });
        } catch (Throwable ignored) {
        }
    }

    /** Push one bot-engine event line (raw JSON from libpmbot.so) into the WebView. */
    public static void pushBotEvent(String rawLine) {
        String payload = rawLine;
        try {
            new JSONObject(rawLine); // validate
        } catch (Throwable t) {
            try {
                payload = new JSONObject()
                        .put("ev", "log")
                        .put("text", rawLine).toString();
            } catch (Throwable ignored) {
                return;
            }
        }
        final String js = "window.__pmBotEvent && window.__pmBotEvent(" + payload + ")";
        final String fjs = js;
        android.os.Handler h = new android.os.Handler(android.os.Looper.getMainLooper());
        h.post(() -> {
            try {
                WebView w = instanceWeb;
                if (w != null) w.evaluateJavascript(fjs, null);
            } catch (Throwable ignored) {
            }
        });
    }

    private static volatile WebView instanceWeb;

    // ---------------- SAF pickers ----------------

    public void pickUpload(String reqId, String destDir, boolean multiple, String profileId) {
        PendingUpload pu = new PendingUpload();
        pu.reqId = reqId;
        pu.destDir = destDir;
        pu.profileId = Profiles.validId(profileId) ? profileId : Profiles.DEFAULT_ID;
        pendingUpload = pu;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        try {
            startActivityForResult(i, REQ_UPLOAD);
        } catch (ActivityNotFoundException e) {
            pendingUpload = null;
            pushEvent(reqId, Bridge.errObj("no file picker available"));
        }
    }

    public void pickSave(String reqId, String path, String suggested, String profileId) {
        PendingSave ps = new PendingSave();
        ps.reqId = reqId;
        ps.path = path;
        ps.profileId = Profiles.validId(profileId) ? profileId : Profiles.DEFAULT_ID;
        pendingSave = ps;
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        if (suggested == null || suggested.isEmpty()) suggested = "file";
        i.putExtra(Intent.EXTRA_TITLE, suggested);
        try {
            startActivityForResult(i, REQ_SAVE);
        } catch (ActivityNotFoundException e) {
            pendingSave = null;
            pushEvent(reqId, Bridge.errObj("no file picker available"));
        }
    }

    public void pickRestore(String reqId, String profileId) {
        pendingRestoreReqId = reqId;
        pendingRestoreProfile = profileId == null ? "default" : profileId;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("application/zip");
        try {
            startActivityForResult(i, REQ_RESTORE);
        } catch (ActivityNotFoundException e) {
            pendingRestoreReqId = null;
            pendingRestoreProfile = null;
            pushEvent(reqId, Bridge.errObj("no file picker available"));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_UPLOAD && pendingUpload != null) {
            PendingUpload pu = pendingUpload;
            pendingUpload = null;
            if (resultCode != RESULT_OK || data == null) {
                pushEvent(pu.reqId, Bridge.errObj("cancelled"));
                return;
            }
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                    uris.add(data.getClipData().getItemAt(i).getUri());
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            JSONArray files = new JSONArray();
            Fs fs = ServerManager.forProfile(this, pu.profileId).fs;
            for (Uri u : uris) {
                try {
                    String name = queryDisplayName(u);
                    if (name == null || name.isEmpty()) name = "upload-" + System.currentTimeMillis();
                    File dest = fs.resolve(pu.destDir + "/" + name);
                    //noinspection ResultOfMethodCallIgnored
                    dest.getParentFile().mkdirs();
                    try (InputStream in = getContentResolver().openInputStream(u);
                         OutputStream out = new FileOutputStream(dest)) {
                        copyStream(in, out);
                    }
                    JSONObject f = ServerManager.JO("name", name, "size", dest.length());
                    files.put(f);
                } catch (Exception e) {
                    files.put(ServerManager.JO("error", Bridge.safeMsg(e)));
                }
            }
            JSONObject res = ServerManager.JO("ok", true, "files", files);
            pushEvent(pu.reqId, res);
        } else if (requestCode == REQ_SAVE && pendingSave != null) {
            PendingSave ps = pendingSave;
            pendingSave = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                pushEvent(ps.reqId, Bridge.errObj("cancelled"));
                return;
            }
            try {
                File src = ServerManager.forProfile(this, ps.profileId).fs.resolve(ps.path);
                try (InputStream in = new FileInputStream(src);
                     OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                    copyStream(in, out);
                }
                JSONObject res = new JSONObject();
                res.put("ok", true);
                res.put("name", src.getName());
                res.put("size", src.length());
                pushEvent(ps.reqId, res);
            } catch (Exception e) {
                pushEvent(ps.reqId, Bridge.errObj(Bridge.safeMsg(e)));
            }
        } else if (requestCode == REQ_RESTORE && pendingRestoreReqId != null) {
            String reqId = pendingRestoreReqId;
            String profileId = pendingRestoreProfile;
            pendingRestoreReqId = null;
            pendingRestoreProfile = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                pushEvent(reqId, Bridge.errObj("cancelled"));
                return;
            }
            if (ServerManager.forProfile(this, profileId).isRunning()) {
                pushEvent(reqId, Bridge.errObj("stop the server first"));
                return;
            }
            bridge.restoreFromUri(data.getData(), reqId, profileId);
        }
    }

    // ---------------- crash log ----------------

    private static final long CRASH_LOG_MAX = 400 * 1024;

    static void appendCrashLog(String line) {
        try {
            android.content.Context appCtx = MainApp.ctxOrNull();
            if (appCtx == null) return; // app not initialized yet, nothing to write to
            File logs = Installer.logsDir(appCtx);
            //noinspection ResultOfMethodCallIgnored
            logs.mkdirs();
            File f = new File(logs, "app-crash.log");
            if (f.length() > CRASH_LOG_MAX) f.delete();
            String stamp = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US)
                    .format(new java.util.Date());
            try (FileOutputStream out = new FileOutputStream(f, true)) {
                out.write(("\n[" + stamp + "] " + line + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
        } catch (Throwable ignored) {
            // never let the logger itself crash the app
        }
    }

    private String queryDisplayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) return c.getString(idx);
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static void copyStream(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[65536];
        int r;
        while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    @Override
    protected void onDestroy() {
        // The server keeps running in the background service; do not kill it here.
        super.onDestroy();
    }
}
