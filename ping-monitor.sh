#!/usr/bin/env bash
#
# ping-monitor.sh - Ping multiple hosts and upload results to Cloudflare Analytics.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.sh"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "ERROR: config.sh not found at $CONFIG_FILE" >&2
    exit 1
fi
# shellcheck source=config.sh
source "$CONFIG_FILE"

# ── helpers ────────────────────────────────────────────────────────────────

get_hostname() {
    cat /proc/sys/kernel/hostname 2>/dev/null || hostname 2>/dev/null || echo "unknown"
}

json_escape() {
    # escape backslash, double-quote, newline, carriage-return, tab
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g; s/\r/\\r/g; s/\t/\\t/g'
}

# Parse Busybox ping statistics.
# Returns: transmitted received loss% min avg max

parse_ping_stats() {
    local output="$1"

    local transmitted=0 received=0 loss=0
    local min=0 avg=0 max=0
    local summary

    # Parse summary line: handles both Busybox and GNU ping formats.
    # Busybox: "3 packets transmitted, 3 packets received, 0% packet loss"
    # GNU:     "3 packets transmitted, 3 received, 0% packet loss, time 2002ms"
    #
    # Use anchored patterns on the summary line only. Greedy ".*\([0-9]\+\)"
    # captures the wrong digit (e.g. the 0 from "0% packet loss" instead of 10).
    summary="$(echo "$output" | grep 'packets transmitted' | head -1)"
    if [[ -n "$summary" ]]; then
        transmitted=$(echo "$summary" | sed -n 's/^\([0-9][0-9]*\) packets transmitted.*/\1/p')
        received=$(echo "$summary"  | sed -n 's/.*, \([0-9][0-9]*\) packets received.*/\1/p')
        if [[ -z "$received" ]]; then
            received=$(echo "$summary" | sed -n 's/.*packets transmitted, \([0-9][0-9]*\) received.*/\1/p')
        fi
    fi

    # Compute loss percentage from transmitted/received (more robust than
    # parsing "% packet loss", and avoids Busybox sed \+ incompatibility).
    if [[ "$transmitted" -gt 0 ]]; then
        received="${received:-0}"
        loss=$(( (transmitted - received) * 100 / transmitted ))
    else
        loss=100
    fi

    # Parse RTT line: handles both Busybox and GNU ping formats.
    # Busybox: "round-trip min/avg/max = 9.375/9.544/9.694 ms"
    # GNU:     "rtt min/avg/max/mdev = 14.342/17.098/19.671/2.179 ms"
    if echo "$output" | grep -qE '(round-trip|^rtt )'; then
        local rtt
        rtt=$(echo "$output" | sed -n 's|.*= \([0-9.]\+\)/\([0-9.]\+\)/\([0-9.]\+\)[/ ].*|\1 \2 \3|p' | head -1)
        min=$(echo "$rtt" | awk '{print $1}')
        avg=$(echo "$rtt" | awk '{print $2}')
        max=$(echo "$rtt" | awk '{print $3}')
    fi

    # Default values for unset fields
    transmitted="${transmitted:-0}"
    received="${received:-0}"
    min="${min:-0}"
    avg="${avg:-0}"
    max="${max:-0}"

    printf '%s %s %s %s %s %s' "$transmitted" "$received" "$loss" "$min" "$avg" "$max"
}

# ── main ───────────────────────────────────────────────────────────────────

HOSTNAME="$(get_hostname)"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Build results array as JSON
RESULTS_JSON="["
first=true
total_failures=0

for target in "${PING_TARGETS[@]}"; do
    # Skip empty lines / comments (defensive)
    [[ -z "$target" || "$target" == \#* ]] && continue

    ping_output="$(ping -c "$PING_COUNT" "$target" 2>&1)"
    ping_rc=$?
    stats="$(parse_ping_stats "$ping_output")"

    read -r transmitted received loss min avg max <<< "$stats"

    if [[ "$ping_rc" -eq 0 ]]; then
        status="ok"
    else
        status="fail"
        ((total_failures++))
    fi

    if $first; then
        first=false
    else
        RESULTS_JSON+=","
    fi

    escaped_target="$(json_escape "$target")"

    RESULTS_JSON+="{\"target\":\"${escaped_target}\",\"transmitted\":${transmitted},\"received\":${received},\"loss_pct\":${loss},\"min_ms\":${min},\"avg_ms\":${avg},\"max_ms\":${max},\"status\":\"${status}\"}"
done

RESULTS_JSON+="]"

# ── Upload ─────────────────────────────────────────────────────────────────

PAYLOAD="{\"hostname\":\"$(json_escape "$HOSTNAME")\",\"timestamp\":\"${TIMESTAMP}\",\"results\":${RESULTS_JSON}}"

CURL_STDERR="$(mktemp)"
trap 'rm -f "$CURL_STDERR"' EXIT

WORKER_HOST="${WORKER_URL#*://}"
WORKER_HOST="${WORKER_HOST%%/*}"

curl_upload() {
    curl -s -w '\nHTTP_CODE:%{http_code}' \
        --max-time "$CURL_TIMEOUT" \
        "${CURL_EXTRA_ARGS[@]}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "X-Shared-Secret: ${SHARED_SECRET}" \
        -d "$PAYLOAD" \
        "${WORKER_URL}${PING_ENDPOINT}" 2>"$CURL_STDERR"
}

CURL_EXTRA_ARGS=()
HTTP_RESPONSE=$(curl_upload)
CURL_RC=$?

# Retry with curl --resolve when router DNS cannot resolve the worker host.
if [[ $CURL_RC -eq 6 && -n "${CURL_DNS_SERVERS:-}" ]]; then
    FALLBACK_DNS="${CURL_DNS_SERVERS%%,*}"
    WORKER_IP="$(resolve_host_via_dns "$WORKER_HOST" "$FALLBACK_DNS")"
    if [[ -n "$WORKER_IP" ]]; then
        : >"$CURL_STDERR"
        CURL_EXTRA_ARGS=(--resolve "${WORKER_HOST}:443:${WORKER_IP}")
        HTTP_RESPONSE=$(curl_upload)
        CURL_RC=$?
    fi
fi

# Extract body and HTTP code from response
HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '/^HTTP_CODE:/d')
HTTP_CODE=$(echo "$HTTP_RESPONSE" | grep '^HTTP_CODE:' | cut -d: -f2)

if [[ $CURL_RC -ne 0 ]]; then
    CURL_DETAIL=""
    if [[ -s "$CURL_STDERR" ]]; then
        CURL_DETAIL=" - $(tr '\n' ' ' < "$CURL_STDERR" | head -c 200)"
    fi
    case "$CURL_RC" in
        6) CURL_DETAIL=" - DNS resolution failed for ${WORKER_URL}${CURL_DETAIL}" ;;
        7) CURL_DETAIL=" - failed to connect to ${WORKER_URL}${CURL_DETAIL}" ;;
        28) CURL_DETAIL=" - operation timed out after ${CURL_TIMEOUT}s${CURL_DETAIL}" ;;
        35) CURL_DETAIL=" - SSL/TLS handshake failed${CURL_DETAIL}" ;;
    esac
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: curl failed (rc=${CURL_RC})${CURL_DETAIL}" >> /tmp/ping-monitor-errors.log
    exit 2
fi

if [[ "$HTTP_CODE" != "200" ]]; then
    if [[ "$HTTP_CODE" == "401" ]]; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: Authentication failed - check SHARED_SECRET in config.sh matches worker secret" >> /tmp/ping-monitor-errors.log
    else
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: worker returned HTTP ${HTTP_CODE} - response: ${HTTP_BODY}" >> /tmp/ping-monitor-errors.log
    fi
    exit 3
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) OK: ${#PING_TARGETS[@]} targets, ${total_failures} failures" >> /tmp/ping-monitor.log
exit 0