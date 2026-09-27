#!/bin/sh
# What the device knows about a failed or stuck test run, for the job log: the crash
# buffer (native crashes and fatal exceptions), the app's threads if it is still
# running (SIGQUIT; an emulator image lets adb read the trace as root), and the log
# lines of the app's own process, which the rest of the system's chatter would bury.
adb=$ANDROID_HOME/platform-tools/adb
echo "== crash buffer"
$adb logcat -d -b crash -v threadtime | tail -n 300
pid=$($adb shell pidof com.roja.mirror | tr -d '\r')
if [ -n "$pid" ]; then
  echo "== threads of com.roja.mirror ($pid)"
  $adb root >/dev/null 2>&1; sleep 3
  $adb shell kill -3 "$pid"; sleep 4
  $adb shell 'ls -t /data/anr/* 2>/dev/null | head -1 | xargs cat 2>/dev/null' | grep -v '^$' | head -n 700
fi
echo "== the app's log"
# Every process the app ran as, WebView's sandboxed renderers included (the log names
# them in "Start proc" lines), plus the tags that speak for it from elsewhere.
pids=$($adb logcat -d -v threadtime | grep -oE 'Start proc [0-9]+:(com\.roja\.mirror|com\.google\.android\.webview:sandboxed)' | awk '{print $3}' | cut -d: -f1 | sort -u | tr '\n' '|')
$adb logcat -d -v threadtime | grep -E "^.{19} +(${pids}NONE) |Roja|AndroidRuntime|DEBUG +:|libc +:.*(roja|Fatal)|ActivityManager.*(roja|crash|died)" | tail -n 700
