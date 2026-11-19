package com.pmpanel.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/** Foreground service that keeps the PocketMine process alive while it runs. */
public class ServerService extends Service {

    public static final String CHANNEL_ID = "pm_server";
    private static final int NOTIF_ID = 1001;
    public static final String ACTION_STOP = "com.pmpanel.app.action.STOP_SERVER";
    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT < 26) {
            // NotificationChannel does not exist on Android 5.x/6.x/7.x
            return;
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID,
                getString(R.string.notif_channel_name), NotificationManager.IMPORTANCE_LOW);
        ch.setDescription(getString(R.string.notif_channel_desc));
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            return handleStart(intent);
        } catch (Throwable t) {
            // Never crash the process because of a notification/FGS quirk on an OEM ROM;
            // the server keeps running, only the foreground guarantee may be lost.
            android.util.Log.e("pmpanel", "onStartCommand failed", t);
            return START_NOT_STICKY;
        }
    }

    private int handleStart(Intent intent) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            // notification button stops EVERY running server (v2.4 multi-server)
            new Thread(() -> ServerManager.stopAll()).start();
            stopForegroundCompat();
            stopSelf();
            return START_NOT_STICKY;
        }
        startInForeground();
        acquireWakeLock();
        return START_STICKY;
    }

    /** stopForeground(int) needs API 24+; use the boolean overload below it. */
    @SuppressWarnings("deprecation")
    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    private void startInForeground() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent stop = new Intent(this, ServerService.class);
        stop.setAction(ACTION_STOP);
        PendingIntent ps = PendingIntent.getService(this, 2, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        /* v2.4 multi-server: the notification lists every running profile, so
         * it stays truthful when servers start/stop (starting another server
         * re-enters onStartCommand and rebuilds this text in place). */
        StringBuilder names = new StringBuilder();
        int running = 0;
        for (String[] p : Profiles.all(this)) {
            ServerManager m = ServerManager.peek(this, p[0]);
            if (m != null && m.isRunning()) {
                running++;
                if (names.length() > 0) names.append(", ");
                if (running <= 4) names.append(p[1]);
            }
        }
        if (running > 4) names.append(" +").append(running - 4);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        String title = running > 1
                ? getString(R.string.notif_title_running) + " (" + running + ")"
                : getString(R.string.notif_title_running);
        Notification n = b
                .setSmallIcon(R.drawable.ic_stat_pm)
                .setContentTitle(title)
                .setContentText(names.length() > 0 ? names.toString() : getString(R.string.app_name))
                .setOngoing(true)
                .setContentIntent(pi)
                .addAction(new Notification.Action.Builder(null, getString(R.string.notif_action_stop), ps).build())
                .build();

        // Android 14/15 can throw (type not allowed / rate limited / permission quirks)
        // on some OEM ROMs. Fall back to a plain startForeground, then give up quietly:
        // the PocketMine process keeps running either way.
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Throwable t) {
            android.util.Log.w("pmpanel", "fgs with type failed, falling back", t);
            try {
                startForeground(NOTIF_ID, n);
            } catch (Throwable ignored) {
            }
        }
    }

    private void acquireWakeLock() {
        if (!Installer.prefs(this).getBoolean("wakeLock", true)) return;
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pmpanel:server");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, ServerService.class);
        try {
            ctx.startForegroundService(i);
        } catch (Exception e) {
            // fall back to plain start (older Android)
            try {
                ctx.startService(i);
            } catch (Exception ignored) {
            }
        }
    }

    public static void stop(Context ctx) {
        // only the exit of the LAST server takes the foreground service down
        if (ServerManager.anyRunning()) return;
        Intent i = new Intent(ctx, ServerService.class);
        ctx.stopService(i);
    }
}
