package com.pmpanel.app;

import android.app.Application;
import android.content.Context;

/**
 * Application holder: safe static access to the app context (used by the crash logger
 * and anywhere a context is needed without an activity).
 */
public class MainApp extends Application {

    private static volatile Context appCtx;

    @Override
    public void onCreate() {
        super.onCreate();
        appCtx = getApplicationContext();
        // Capture hard crashes early on every device; the log is visible in the Logs tab.
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            MainActivity.appendCrashLog("FATAL on " + t.getName() + ": "
                    + android.util.Log.getStackTraceString(e));
            if (prev != null) prev.uncaughtException(t, e);
        });
    }

    /** May return null only before Application.onCreate completes (callers must tolerate). */
    public static Context ctxOrNull() {
        return appCtx;
    }
}
