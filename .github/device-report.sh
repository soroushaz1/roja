#!/bin/sh
# What the device knows about a failed or stuck test run, for the job log: the app's
# threads, taken with SIGQUIT (on an emulator image adb can read the trace as root),
# then logcat's warnings and errors with the app's own lines.
adb=$ANDROID_HOME/platform-tools/adb
pid=$($adb shell pidof com.roja.mirror | tr -d '\r')
if [ -n "$pid" ]; then
  echo "== threads of com.roja.mirror ($pid)"
  $adb root >/dev/null 2>&1; sleep 3
  $adb shell kill -3 "$pid"; sleep 4
  $adb shell 'ls -t /data/anr/* 2>/dev/null | head -1 | xargs cat 2>/dev/null' | grep -v '^$' | head -n 700
fi
echo "== logcat"
$adb logcat -d -v threadtime '*:W' Roja:D RojaTest:I RojaMirror:I | tail -n 800
