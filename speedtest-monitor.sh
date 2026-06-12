#!/usr/bin/env bash
#
# speedtest-monitor.sh - Run speedtest-go and upload results to Cloudflare Analytics.
#
# Designed for OpenWRT. Requires speedtest-go installed.
# Run via cron, e.g. every hour:
#   0 * * * * /root/scripts/speedtest-monitor.sh
#
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
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g; s/\r/\\r/g; s/\t/\\t/g'
}

# ── main ───────────────────────────────────────────────────────────────────

HOSTNAME="$(get_hostname)"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Check that speedtest-go is available
if ! command -v speedtest-go &>/dev/null; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: speedtest-go not found in PATH" >> /tmp/speedtest-monitor-errors.log
    exit 4
fi

# Run speedtest. --json outputs one JSON object to stdout.
SPEEDTEST_JSON="$(speedtest-go --json 2>/tmp/speedtest-monitor-stderr.log)"
SPEEDTEST_RC=$?

if [[ $SPEEDTEST_RC -ne 0 ]]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: speedtest-go failed (rc=${SPEEDTEST_RC})" >> /tmp/speedtest-monitor-errors.log
    exit 5
fi

if [[ -z "$SPEEDTEST_JSON" ]]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: speedtest-go produced empty output" >> /tmp/speedtest-monitor-errors.log
    exit 6
fi

# ── Upload ─────────────────────────────────────────────────────────────────
# Send the raw speedtest-go JSON to the worker. The worker will parse it.

PAYLOAD="{\"hostname\":\"$(json_escape "$HOSTNAME")\",\"timestamp\":\"${TIMESTAMP}\",\"speedtest\":${SPEEDTEST_JSON}}"

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
        "${WORKER_URL}${SPEEDTEST_ENDPOINT}" 2>"$CURL_STDERR"
}

CURL_EXTRA_ARGS=()
HTTP_RESPONSE=$(curl_upload)
CURL_RC=$?

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
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: curl failed (rc=${CURL_RC})${CURL_DETAIL}" >> /tmp/speedtest-monitor-errors.log
    exit 2
fi

if [[ "$HTTP_CODE" != "200" ]]; then
    if [[ "$HTTP_CODE" == "401" ]]; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: Authentication failed - check SHARED_SECRET in config.sh matches worker secret" >> /tmp/speedtest-monitor-errors.log
    else
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: worker returned HTTP ${HTTP_CODE} - response: ${HTTP_BODY}" >> /tmp/speedtest-monitor-errors.log
    fi
    exit 3
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) OK: speedtest uploaded" >> /tmp/speedtest-monitor.log
exit 0