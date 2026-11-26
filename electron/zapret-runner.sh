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
if [ "$MODE" = stop ]; then WORK="$DATA/netbridge-stop"; fi
STARTED=$(/bin/date +%s)
ROLLING_BACK=0
PROBE_PIDS=''
PROBE_DIR=''
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
stop_probes() {
    # sudo forwards TERM to curl. Track sudo directly, not shell pipeline wrappers.
    for PROBE_PID in $PROBE_PIDS; do /bin/kill -TERM "$PROBE_PID" 2>/dev/null || true; done
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
    if [ -n "$PROBE_DIR" ]; then /bin/rm -rf "$PROBE_DIR"; fi
    /bin/rmdir "$LOCK" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
if /usr/bin/pgrep -x ZapretMac >/dev/null 2>&1; then
    progress 'Закройте оригинальное приложение ZapretMac перед управлением через Netbridge'
    exit 6
fi
if [ "$MODE" = stop ]; then
    TRUSTED=1
    for ITEM in '/Library/Application Support' "$BASE" "$BASE/stop.sh"; do
        if [ ! -L "$ITEM" ] && META=$(/usr/bin/stat -f '%u %Lp' "$ITEM" 2>/dev/null); then
            OWNER=${META%% *}
            PERMS=${META#* }
            case "$PERMS" in
                ''|*[!0-7]*) ;;
                *) if [ "$OWNER" = 0 ] && [ "$(( 0$PERMS & 022 ))" -eq 0 ]; then continue; fi ;;
            esac
        fi
        TRUSTED=0
        break
    done
    if [ "$TRUSTED" -ne 1 ] || [ ! -f "$BASE/stop.sh" ]; then
        progress 'Не найден безопасный системный скрипт остановки ZapretMac'
        exit 8
    fi
    /bin/sh "$BASE/stop.sh"
    exit 0
fi
check_abort
PROBE_DIR=$(/usr/bin/mktemp -d /private/tmp/netbridge-probes.XXXXXXXX)
# The route may change while the macOS authorization dialog is open.
ROUTE=$(/sbin/route -n get default 2>/dev/null || true)
IFACE=$(printf '%s\n' "$ROUTE" | /usr/bin/awk '/^[[:space:]]*interface:/{print $2; exit}')
GATEWAY=$(printf '%s\n' "$ROUTE" | /usr/bin/awk '/^[[:space:]]*gateway:/{print $2; exit}')
case "$IFACE" in
    utun[0-9]*|tun[0-9]*|ppp[0-9]*|ipsec[0-9]*|gif[0-9]*|stf[0-9]*)
        progress "Отключите VPN/туннелирование ($IFACE) и повторите автоподбор. Сетевые службы не изменены."
        exit 7 ;;
    ''|lo0)
        progress 'ZapretMac требует подключения IPv4 со шлюзом через Wi-Fi или Ethernet. Сетевые службы не изменены.'
        exit 7 ;;
esac
if ! printf '%s\n' "$GATEWAY" | /usr/bin/grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    progress 'ZapretMac требует подключения IPv4 со шлюзом через Wi-Fi или Ethernet. Сетевые службы не изменены.'
    exit 7
fi

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
if INSTALL_OUTPUT=$(/bin/sh "$SOURCE/install.sh" "$SOURCE" "$DATA" 2>&1); then
    :
else
    printf 'Не удалось запустить ZapretMac: %s\n' "$INSTALL_OUTPUT" | as_user /usr/bin/tee "$WORK/failure" >/dev/null
    exit 1
fi
ready
start_probe() {
    /usr/bin/sudo -n -u "#$UID_NUMBER" -H /usr/bin/curl -q --noproxy '*' --proto '=https' --connect-timeout 3 --max-time 8 \
        --max-filesize 2097152 --silent --show-error --output /dev/null \
        --write-out '%{http_code}\t%{time_total}' "$1" >"$PROBE_DIR/$2" 2>/dev/null &
    LAST_PID=$!
    PROBE_PIDS="$PROBE_PIDS $LAST_PID"
}
finish_probe() {
    NAME=$1
    EXPECTED=$2
    VALUE='000	8'
    if wait "$3"; then VALUE=$(/bin/cat "$PROBE_DIR/$NAME"); fi
    CODE=$(printf '%s\n' "$VALUE" | /usr/bin/cut -f1)
    TIME=$(printf '%s\n' "$VALUE" | /usr/bin/cut -f2)
    OK=0
    [ "$CODE" != "$EXPECTED" ] || OK=1
    printf '%s\t%s\t%s\t%s\n' "$NAME" "$OK" "$CODE" "$TIME" >>"$PROBE_DIR/metrics"
}
measure() {
    : >"$PROBE_DIR/metrics"
    ROUND=1
    while [ "$ROUND" -le 2 ]; do
        check_abort
        start_probe https://www.youtube.com/generate_204 youtube
        P1=$LAST_PID
        start_probe https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg thumbnail
        P2=$LAST_PID
        start_probe https://redirector.googlevideo.com/report_mapping video-route
        P3=$LAST_PID
        while /bin/kill -0 "$P1" 2>/dev/null ||
              /bin/kill -0 "$P2" 2>/dev/null ||
              /bin/kill -0 "$P3" 2>/dev/null; do
            check_abort
            /bin/sleep 0.2
        done
        finish_probe youtube 204 "$P1"
        finish_probe thumbnail 200 "$P2"
        finish_probe video-route 200 "$P3"
        PROBE_PIDS=''
        ROUND=$((ROUND + 1))
    done
    METRICS=$(/usr/bin/awk -F '\t' '{n+=$2; t+=$4; if ($1=="youtube") y+=$2} END {printf "%d\t%.4f\t%d\n", n,t,y}' "$PROBE_DIR/metrics")
}

if [ -n "$PREFERRED" ]; then
    progress 'Проверка сохранённого профиля'
    measure
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
    measure
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
measure
SCORE=$(printf '%s' "$METRICS" | /usr/bin/cut -f1)
YOUTUBE=$(printf '%s' "$METRICS" | /usr/bin/cut -f3)
[ "$YOUTUBE" -eq 2 ] && [ "$SCORE" -ge 4 ] || exit 4
check_abort
printf '%s\n' "$BEST" | as_user /usr/bin/tee "$WORK/best" >/dev/null
COMMITTED=1
progress 'Стратегия применена'
