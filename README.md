# cf-netwatch

- Monitor network connectivity and performance from a Linux/POSIX-style
 host (e.g., an OpenWrt router, Raspberry Pi, or a home server)
- Store in Cloudflare Analytics Engine
- Visualize it with a self-hosted dashboard on Cloudflare

## What it does

- **Ping monitoring**: runs `ping` against a list of targets on a schedule, records latency and packet loss.
- **Speedtest monitoring**: runs `speedtest-go`, records download/upload speeds, latency, jitter, and packet loss per server. Not tested yet.
- **Dashboard**:
    - serves an HTML page with Chart.js graphs
    - pulls live data from Cloudflare Analytics Engine via SQL
    - automatic refresh every five minutes

## Cost

- Runs entirely on Cloudflare's free tier.
- No custom domain required: works on `*.workers.dev`.

## Analytics Engine notes

- Data retention is 90 days (not configurable).
- High-volume writes may be sampled.
- Queries use a special SQL dialect.

## Authentication and access control

Posting measurements to Cloudflare requires a shared secret.

By default, the API and dashboard are restricted by IP_ALLOWLIST
in the worker configuration.

In case you change IP_ALLOWLIST to a public configuration, it is recommended
not to show any sensitive information, such as PII or details about the internal
network.

See section below about restricting access.

## Prerequisites

- A Cloudflare account
- `wrangler` CLI installed (`npm install -g wrangler`)
- A monitoring host with:
  - POSIX-compatible system
  - Bash (scripts use bashisms: arrays, `[[ ]]`, `source`)
  - GNU or BusyBox utilities (`grep`, `sed`, `ping`, etc.)
  - `curl`
  - Optionally `speedtest-go` for speed testing
  - Optionally `nslookup` or `dig` for DNS fallback when uploading


## Setup

### 1. Configure the Cloudflare Worker

1. In the Cloudflare dashboard, create an **API token** with permissions for **Analytics Engine**.
2. Edit `config.js` to set `IP_ALLOWLIST` and other configuration options.
3. Deploy the Worker:
   ```bash
   cd cf-worker
   wrangler deploy
   ```
4. Set three **secrets** on the Worker:
   ```bash
   wrangler secret put ACCOUNT_ID      # Your Cloudflare account ID
   wrangler secret put API_TOKEN       # API token with Analytics Engine access
   wrangler secret put SHARED_SECRET   # A random string you choose
   ```

### 2. Configure the monitoring scripts

Edit `config.sh`:

| Variable | What to set |
|----------|-------------|
| `WORKER_URL` | Your deployed Worker URL |
| `SHARED_SECRET` | The same secret you set above (not API token) |
| `PING_TARGETS` | Hosts / IPs to ping |

### 3. Install on the monitoring host

Copy to the machine that will run the checks:

```bash
scp config.sh ping-monitor.sh speedtest-monitor.sh user@router:/opt/netwatch/
```

Add to cron. For example, run every 15 minutes:

```bash
*/15 * * * * /opt/netwatch/ping-monitor.sh
```

If you are on Windows using WSL, verify that the cron service is started.

```
sudo service cron start
```

### 4. View the dashboard

Open your Worker URL in a web browser:

```
https://<your-worker>.workers.dev/dashboard/ping
```

### Restricting access to the dashboard

There are several options:

1. Configure `IP_ALLOWLIST` in `config.js`

2. Set up Cloudflare Access

3. Configure a Cloudflare Security rule to limit access to
   specific IP addresses, ASNs, countries, or other criteria.
   This requires a custom domain, but when Cloudflare makes a TLS
   certificate, it reveals the subdomain in the certificate.
   (The subdomain will not be hidden.)

## Project layout

```
cf-netwatch/
├── cf-worker/
│   ├── src/
│   │   ├── index.js          # Worker: routes, auth, AE queries
│   │   ├── config.js         # Dashboard config (timezone, target sets, hidden targets)
│   │   └── dashboard.html    # Static HTML + Chart.js dashboard
│   └── wrangler.toml         # Worker deployment config
├── config.sh                 # Shared config (URL, secret, targets)
├── ping-monitor.sh           # Bash: ping targets, POST results
├── speedtest-monitor.sh      # Bash: speedtest, POST results
└── README.md
```

## Future directions

- Finish building out speed testing.
- Store results from Bash into a queue, in case pushing to Cloudflare fails.
- Split permissions so that users authenticated via Cloudflare Access can see
  more metrics on the dashboard.

## License

Copyright (c) 2006 by Andrew Ziem.
Licensed under the GNU General Public License version 3 or later.
See [LICENSE.md](LICENSE.md) for details.