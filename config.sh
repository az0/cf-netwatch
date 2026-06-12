#!/usr/bin/env bash
# Shared configuration for network monitor scripts
# Source this file from ping-monitor.sh and speedtest-monitor.sh

# Cloudflare Worker endpoint (set this to your deployed worker URL)
WORKER_URL="${WORKER_URL:-https://cf-netwatch.yourdomain.com}"

# Shared secret for authentication (set this, keep it private)
SHARED_SECRET="${SHARED_SECRET:-your-secret-here}"

if [[ -z "${SHARED_SECRET:-}" || "${SHARED_SECRET}" == "your-secret-here" ]]; then
    echo "ERROR: SHARED_SECRET must be set in config.sh or environment" >&2
    exit 1
fi

# API paths
PING_ENDPOINT="/api/ping"
SPEEDTEST_ENDPOINT="/api/speedtest"

# Number of ping packets per target
PING_COUNT="${PING_COUNT:-10}"

# Timeout in seconds for curl requests
CURL_TIMEOUT="${CURL_TIMEOUT:-15}"

# Fallback DNS for worker uploads when system DNS fails (curl rc=6).
# Comma-separated; first entry is used with nslookup/dig + curl --resolve.
# Set empty to disable retry.
CURL_DNS_SERVERS="${CURL_DNS_SERVERS:-1.1.1.1,8.8.8.8}"

# Resolve a hostname via a specific DNS server (IPv4 only).
resolve_host_via_dns() {
    local host="$1"
    local server="${2:-1.1.1.1}"
    if command -v nslookup >/dev/null 2>&1; then
        nslookup "$host" "$server" 2>/dev/null | awk '/^Address [0-9]/ { print $2; exit }'
        return
    fi
    if command -v dig >/dev/null 2>&1; then
        dig +short "$host" "@$server" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1
    fi
}

# Ping targets: one per line, comments allowed.
# You can list a combination of hostnames and IP addresses.
# Choose targets based on your needs.
# Prioritize targets for which uptime and latency are important.
# Latency sensitive systems include DNS, real-time voice, and gaming.
PING_TARGETS=(
    "1.1.1.1"
    "8.8.8.8"
    "9.9.9.9"
    "doh.opendns.com"
)
