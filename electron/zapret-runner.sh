#!/bin/sh
# Invoked once through macOS authorization. Probes must run as the logged-in user:
# upstream pf rules intentionally exclude root's traffic.
set -eu
SOURCE=$1
DATA=$2
UID_NUMBER=$3
GID_NUMBER=$4
MODE=$5
PREFERRED=${6:-}
BASE='/Library/Application Support/ZapretMac'
WORK="$DATA/netbridge-test"
STARTED=$(/bin/date +%s)
ROLLING_BACK=0
PROBE_PIDS=''
case "$DATA" in /Users/*/'Library/Application Support/ZapretMac') ;; *) exit 2 ;; esac
case "$UID_NUMBER:$GID_NUMBER" in *[!0-9:]*|:|*:|:*) exit 2 ;; esac
[ "$UID_NUMBER" -gt 0 ] || exit 2
case "$MODE" in stop|optimize) ;; *) exit 2 ;; esac
[ ! -L "$DATA" ] && [ ! -L "$WORK" ] || exit 2

as_user() { /usr/bin/sudo -u "#$UID_NUMBER" -H "$@"; }
progress() { as_user /usr/bin/printf '%s\n' "$1" | as_user /usr/bin/tee "$WORK/progress" >/dev/null; }
write_state() { as_user /usr/bin/printf '%s\n' "$2" | as_user /usr/bin/tee "$DATA/$1" >/dev/null; }
cancelled() { [ -f "$WORK/cancel" ]; }
check_abort() {
    [ "$ROLLING_BACK" -eq 0 ] || return 0
    if cancelled; then exit 130; fi
    if [ "$(( $(/bin/date +%s) - STARTED ))" -ge 1800 ]; then
        progress 'Превышено время подбора'
        exit 124
    fi
}
terminate_probe() {
    # Only descendants of our tracked probe jobs, never the system engine.
    for CHILD in $(/usr/bin/pgrep -P "$1" 2>/dev/null || true); do
        terminate_probe "$CHILD"
    done
    /bin/kill -KILL "$1" 2>/dev/null || true
}
stop_probes() {
    for PROBE_PID in $PROBE_PIDS; do terminate_probe "$PROBE_PID"; done
    for PROBE_PID in $PROBE_PIDS; do wait "$PROBE_PID" 2>/dev/null || true; done
    PROBE_PIDS=''
}
ready() {
    COUNT=0
    while [ "$COUNT" -lt 100 ]; do
        check_abort
        if /bin/launchctl print system/io.github.flowseal.zapretmac >/dev/null 2>&1 &&
           /usr/bin/pgrep -x utunws >/dev/null 2>&1 &&
           /sbin/ifconfig utun50 >/dev/null 2>&1 &&
           /sbin/pfctl -a com.apple/zapret-macos -sr 2>/dev/null | /usr/bin/grep -q route-to; then return 0; fi
        COUNT=$((COUNT + 1))
        /bin/sleep 0.2
    done
    return 1
}
restart_ready() {
    check_abort
    OLD_PID=$(/usr/bin/pgrep -x utunws || true)
    /bin/sh "$BASE/restart.sh" || return 1
    COUNT=0
    while [ "$(/usr/bin/pgrep -x utunws || true)" = "$OLD_PID" ]; do
        check_abort
        COUNT=$((COUNT + 1))
        [ "$COUNT" -lt 50 ] || return 1
        /bin/sleep 0.2
    done
    ready
}

# A root-owned lock serializes all Netbridge operations, including after an app crash.
LOCK=/var/run/netbridge-zapret.lock
/bin/mkdir "$LOCK" 2>/dev/null || { progress 'Другая операция Netbridge ещё выполняется; если приложение аварийно завершилось, перезагрузите Mac'; exit 6; }
cleanup() {
    stop_probes
    /bin/rmdir "$LOCK" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
if /usr/bin/pgrep -x ZapretMac >/dev/null 2>&1; then
    progress 'Закройте оригинальное приложение ZapretMac перед управлением через Netbridge'
    exit 6
fi
if [ "$MODE" = stop ]; then /bin/sh "$SOURCE/stop.sh"; exit 0; fi
check_abort

WAS_RUNNING=0
if /bin/launchctl print system/io.github.flowseal.zapretmac >/dev/null 2>&1 &&
   /usr/bin/pgrep -x utunws >/dev/null 2>&1; then WAS_RUNNING=1; fi
COMMITTED=0
ORIGINAL=$(/bin/cat "$DATA/selected-strategy")
IPSET=$(/bin/cat "$DATA/ipset-mode")
rollback() {
    STATUS=$?
    trap - EXIT INT TERM HUP
    ROLLING_BACK=1
    stop_probes
    if [ "$COMMITTED" -eq 0 ]; then
        RESTORE_FAILED=0
        progress 'Восстановление прежних настроек' || true
        write_state selected-strategy "$ORIGINAL" || RESTORE_FAILED=1
        write_state ipset-mode "$IPSET" || RESTORE_FAILED=1
        if [ "$WAS_RUNNING" -eq 1 ]; then
            restart_ready || RESTORE_FAILED=1
        else
            /bin/sh "$SOURCE/stop.sh" || RESTORE_FAILED=1
        fi
        if [ "$RESTORE_FAILED" -eq 1 ]; then
            progress 'Ошибка восстановления. Отключите Zapret и повторите запуск.' || true
            cleanup
            exit 5
        fi
    fi
    cleanup
    if [ "$STATUS" -eq 130 ]; then
        printf 'cancelled\n' | as_user /usr/bin/tee "$WORK/outcome" >/dev/null || true
    fi
    exit "$STATUS"
}
trap rollback EXIT
trap 'exit 130' INT TERM HUP

progress 'Запуск системного сервиса'
if [ -n "$PREFERRED" ]; then
    /usr/bin/awk -F '\t' -v id="$PREFERRED" '$1==id {found=1} END {exit !found}' "$SOURCE/strategies.tsv" || exit 2
    write_state selected-strategy "$PREFERRED"
fi
check_abort
/bin/sh "$SOURCE/install.sh" "$SOURCE" "$DATA"
ready
probe() {
    NAME=$1
    URL=$2
    EXPECTED=$3
    OUT=$4
    VALUE=$(as_user /usr/bin/curl --noproxy '*' --proto '=https' --connect-timeout 3 --max-time 8 \
        --max-filesize 2097152 --silent --show-error --output /dev/null \
        --write-out '%{http_code}\t%{time_total}' "$URL" 2>/dev/null) || VALUE='000	8'
    CODE=$(printf '%s\n' "$VALUE" | /usr/bin/cut -f1)
    TIME=$(printf '%s\n' "$VALUE" | /usr/bin/cut -f2)
    OK=0
    [ "$CODE" != "$EXPECTED" ] || OK=1
    printf '%s\t%s\t%s\t%s\n' "$NAME" "$OK" "$CODE" "$TIME" | as_user /usr/bin/tee "$OUT" >/dev/null
}
measure() {
    PREFIX=$1
    ROUND=1
    while [ "$ROUND" -le 2 ]; do
        check_abort
        probe youtube https://www.youtube.com/generate_204 204 "$WORK/$PREFIX-$ROUND-youtube" &
        P1=$!
        probe thumbnail https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg 200 "$WORK/$PREFIX-$ROUND-thumbnail" &
        P2=$!
        probe video-route https://redirector.googlevideo.com/report_mapping 200 "$WORK/$PREFIX-$ROUND-video" &
        P3=$!
        PROBE_PIDS="$P1 $P2 $P3"
        while /bin/kill -0 "$P1" 2>/dev/null ||
              /bin/kill -0 "$P2" 2>/dev/null ||
              /bin/kill -0 "$P3" 2>/dev/null; do
            check_abort
            /bin/sleep 0.2
        done
        wait "$P1" "$P2" "$P3" || return 1
        PROBE_PIDS=''
        ROUND=$((ROUND + 1))
    done
    METRICS=$(/usr/bin/awk -F '\t' '{n+=$2; t+=$4; if ($1=="youtube") y+=$2} END {printf "%d\t%.4f\t%d\n", n,t,y}' "$WORK/$PREFIX"-*)
}

if [ -n "$PREFERRED" ]; then
    progress 'Проверка сохранённого профиля'
    measure cached
    SCORE=$(printf '%s' "$METRICS" | /usr/bin/cut -f1)
    YOUTUBE=$(printf '%s' "$METRICS" | /usr/bin/cut -f3)
    check_abort
    if [ "$YOUTUBE" -eq 2 ] && [ "$SCORE" -ge 4 ]; then
        printf '%s\n' "$PREFERRED" | as_user /usr/bin/tee "$WORK/best" >/dev/null
        printf 'yes\n' | as_user /usr/bin/tee "$WORK/cached" >/dev/null
        COMMITTED=1
        progress 'Сохранённый профиль проверен'
        exit 0
    fi
fi
BEST=''
BEST_SCORE=-1
BEST_TIME=99999
INDEX=0
TOTAL=$(/usr/bin/wc -l <"$SOURCE/strategies.tsv" | /usr/bin/tr -d ' ')
TAB=$(printf '\t')
while IFS="$TAB" read -r STRATEGY NAME; do
    [ -n "$STRATEGY" ] || continue
    case "$STRATEGY" in general|general-*) ;; *) exit 2 ;; esac
    printf '%s' "$STRATEGY" | /usr/bin/grep -Eq '^general(-[a-z0-9]+)*$' || exit 2
    [ -f "$SOURCE/strategies/$STRATEGY.conf.in" ] || exit 2
    check_abort
    INDEX=$((INDEX + 1))
    progress "Стратегия $INDEX/$TOTAL: $NAME"
    write_state selected-strategy "$STRATEGY"
    # Keep the user's IPSet mode so testing and the final application agree.
    if ! restart_ready; then continue; fi
    measure "candidate-$INDEX"
    SCORE=$(printf '%s' "$METRICS" | /usr/bin/cut -f1)
    TIME=$(printf '%s' "$METRICS" | /usr/bin/cut -f2)
    YOUTUBE=$(printf '%s' "$METRICS" | /usr/bin/cut -f3)
    printf '%s\t%s\t%s\t%s\n' "$STRATEGY" "$SCORE" "$TIME" "$YOUTUBE" | as_user /usr/bin/tee -a "$WORK/results.tsv" >/dev/null
    if [ "$YOUTUBE" -eq 2 ] && [ "$SCORE" -ge 4 ] &&
       { [ "$SCORE" -gt "$BEST_SCORE" ] ||
         { [ "$SCORE" -eq "$BEST_SCORE" ] && /usr/bin/awk -v a="$TIME" -v b="$BEST_TIME" 'BEGIN {exit !(a<b)}'; }; }; then
        BEST=$STRATEGY
        BEST_SCORE=$SCORE
        BEST_TIME=$TIME
    fi
done <"$SOURCE/strategies.tsv"
check_abort
[ -n "$BEST" ] || { progress 'Рабочая стратегия не найдена'; exit 3; }
progress 'Повторная проверка выбранной стратегии'
write_state selected-strategy "$BEST"
restart_ready
measure final
SCORE=$(printf '%s' "$METRICS" | /usr/bin/cut -f1)
YOUTUBE=$(printf '%s' "$METRICS" | /usr/bin/cut -f3)
[ "$YOUTUBE" -eq 2 ] && [ "$SCORE" -ge 4 ] || exit 4
check_abort
printf '%s\n' "$BEST" | as_user /usr/bin/tee "$WORK/best" >/dev/null
COMMITTED=1
progress 'Стратегия применена'
