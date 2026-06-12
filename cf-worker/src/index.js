import DASHBOARD_HTML from './dashboard.html';
import {
  IP_ALLOWLIST,
  PING_BUCKET_MINUTES,
  PING_HIDDEN_TARGETS,
  PING_SOURCE_HOSTNAME,
  PING_TARGET_SETS,
  TIMEZONE,
} from './config.js';

/**
 * network-monitor Worker
 *
 * Receives ping and speedtest data from OpenWRT routers and writes
 * structured data points to Cloudflare Workers Analytics Engine.
 *
 * Endpoints:
 *   POST /api/ping            - batch ping results (auth required)
 *   POST /api/speedtest       - speedtest-go JSON results (auth required)
 *   GET  /api/analytics/ping  - ping time-series JSON (public)
 *   GET  /dashboard/ping      - HTML dashboard with charts (public)
 *
 * Auth: X-Shared-Secret header must match SHARED_SECRET secret.
 */

// ── Helpers ────────────────────────────────────────────────────────────────

function unauthorized() {
  return new Response('Unauthorized', { status: 401 });
}

function forbidden() {
  return new Response('Forbidden', { status: 403 });
}

function badRequest(msg) {
  return new Response(msg || 'Bad Request', { status: 400 });
}

/**
 * Convert an IPv4 or IPv6 address string to a BigInt for CIDR comparison.
 */
function parseIpToBigInt(ip) {
  if (ip.includes('.')) {
    const num = ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
    return BigInt(num);
  }
  let parts = ip.split(':');
  if (ip.includes('::')) {
    const idx = parts.indexOf('');
    const missing = 8 - (parts.length - 1);
    parts = [...parts.slice(0, idx), ...Array(missing).fill('0'), ...parts.slice(idx + 1)];
  }
  const hex = parts.map(p => p.padStart(4, '0')).join('');
  return BigInt('0x' + hex);
}

/**
 * Check if an IP address matches a CIDR block.
 */
function ipMatchesCidr(ip, cidr) {
  const [network, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const ipNum = parseIpToBigInt(ip);
  const netNum = parseIpToBigInt(network);
  const bits = ip.includes('.') ? 32 : 128;
  const shift = BigInt(bits - prefix);
  return (ipNum >> shift) === (netNum >> shift);
}

/**
 * Check if an IP is allowed by the given CIDR allowlist.
 * '0.0.0.0/0' and '::/0' match everything.
 */
function isIpAllowed(ip, allowlist) {
  for (const cidr of allowlist) {
    if (cidr === '0.0.0.0/0' || cidr === '::/0') {
      return true;
    }
    if (ip && ipMatchesCidr(ip, cidr)) {
      return true;
    }
  }
  return false;
}

function getAllowlist(env) {
  if (env.IP_ALLOWLIST) {
    return env.IP_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean);
  }
  return IP_ALLOWLIST;
}

/**
 * Validate the shared secret from the request header against the env secret.
 */
function validateAuth(request, env) {
  const secret = request.headers.get('X-Shared-Secret');
  return secret === env.SHARED_SECRET;
}

/**
 * Client IP and AS info from the inbound Worker request (router egress).
 */
function getRequestClientInfo(request) {
  const cf = request.cf || {};
  const forwarded = request.headers.get('X-Forwarded-For');
  const clientIp = String(
    request.headers.get('CF-Connecting-IP') ||
    (forwarded ? forwarded.split(',')[0].trim() : '') ||
    ''
  ).slice(0, 64);
  const asNumber = String(cf.asn || '').slice(0, 32);
  const asName = String(cf.asOrganization || cf.aso || '').slice(0, 256);
  return { clientIp, asNumber, asName };
}

/**
 * Query the Cloudflare Analytics Engine SQL API.
 * Requires ACCOUNT_ID and API_TOKEN secrets set on the Worker.
 */
async function queryAnalyticsEngine(env, sql) {
  const accountId = env.ACCOUNT_ID;
  const apiToken = env.API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error('ACCOUNT_ID and API_TOKEN secrets must be configured');
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: sql,
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Analytics Engine API error ${res.status}: ${text}`);
  }

  return res.json();
}

// ── Ping handler ───────────────────────────────────────────────────────────
//
// Expects body: {
//   hostname: string,
//   timestamp: string (ISO 8601),
//   results: [
//     { target, transmitted, received, loss_pct, min_ms, avg_ms, max_ms, status }
//   ]
// }

function handlePing(env, body, request) {
  const { hostname, results } = body;

  if (!hostname || !Array.isArray(results)) {
    return badRequest('Missing hostname or results array');
  }

  const { clientIp, asNumber, asName } = getRequestClientInfo(request);

  console.log(`[Ping] Processing ${results.length} results for hostname: ${hostname}, IP=${clientIp}, AS=${asNumber} (${asName})`);
  let written = 0;
  for (const r of results) {
    if (!r.target) continue;

    const target = String(r.target).slice(0, 256);
    const status = String(r.status || 'unknown').slice(0, 32);
    const hn = String(hostname).slice(0, 128);

    console.log(`[Ping] Writing data point: hostname=${hn}, target=${target}, status=${status}, avg_ms=${r.avg_ms}, loss_pct=${r.loss_pct}`);
    env.NETWATCH_PING.writeDataPoint({
      blobs: [hn, target, status, asNumber, asName, clientIp],
      doubles: [
        Number(r.min_ms) || 0,
        Number(r.avg_ms) || 0,
        Number(r.max_ms) || 0,
        Number(r.loss_pct) || 0,
      ],
      indexes: [hn],
    });
    written++;
  }

  console.log(`[Ping] Successfully wrote ${written} data points`);
  return new Response(JSON.stringify({ ok: true, written }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Speedtest handler ──────────────────────────────────────────────────────
//
// Expects body: {
//   hostname: string,
//   timestamp: string (ISO 8601),
//   speedtest: { ... raw speedtest-go --json output ... }
// }

function handleSpeedtest(env, body, request) {
  const { hostname, speedtest } = body;

  if (!hostname || !speedtest) {
    return badRequest('Missing hostname or speedtest data');
  }

  const { clientIp, asNumber, asName } = getRequestClientInfo(request);

  const hn = String(hostname).slice(0, 128);
  const servers = speedtest.servers;
  const userInfo = speedtest.user_info || {};

  if (!Array.isArray(servers) || servers.length === 0) {
    return badRequest('No server results in speedtest data');
  }

  console.log(`[Speedtest] Processing ${servers.length} server results for hostname: ${hostname}, IP=${clientIp}, AS=${asNumber} (${asName})`);
  let written = 0;
  for (const server of servers) {
    const serverName = String(server.name || 'unknown').slice(0, 256);
    const country = String(server.country || 'unknown').slice(0, 128);
    const isp = String(userInfo.Isp || server.sponsor || 'unknown').slice(0, 256);

    // Convert latency from nanoseconds to milliseconds
    const latencyNs = Number(server.latency) || 0;
    const jitterNs = Number(server.jitter) || 0;
    const latencyMs = latencyNs / 1_000_000;
    const jitterMs = jitterNs / 1_000_000;

    // Speeds from speedtest-go are in bytes/sec; convert to Mbps
    const dlSpeed = Number(server.dl_speed) || 0;
    const ulSpeed = Number(server.ul_speed) || 0;
    const dlMbps = (dlSpeed * 8) / 1_000_000;
    const ulMbps = (ulSpeed * 8) / 1_000_000;

    // Packet loss
    const packetLoss = server.packet_loss || {};
    const lossPct = packetLoss.max !== undefined ? Number(packetLoss.max) : 0;

    console.log(`[Speedtest] Writing data point: hostname=${hn}, server=${serverName}, dl_mbps=${dlMbps.toFixed(2)}, ul_mbps=${ulMbps.toFixed(2)}, latency_ms=${latencyMs.toFixed(3)}`);
    env.NETWATCH_SPEEDTEST.writeDataPoint({
      blobs: [hn, serverName, country, isp, asNumber, asName, clientIp],
      doubles: [
        Number(dlMbps.toFixed(2)),
        Number(ulMbps.toFixed(2)),
        Number(latencyMs.toFixed(3)),
        Number(jitterMs.toFixed(3)),
        Number(lossPct),
      ],
      indexes: [hn],
    });
    written++;
  }

  console.log(`[Speedtest] Successfully wrote ${written} data points`);
  return new Response(JSON.stringify({ ok: true, written }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Analytics: Ping JSON API ───────────────────────────────────────────────
//
// GET /api/analytics/ping?hours=24&interval=60
// Returns time-series ping data grouped by interval and target.
// interval: bucket size in minutes - 15, 30, or 60 (default 60).
/*
https://developers.cloudflare.com/analytics/analytics-engine/sampling/
| Use case | Example without sampling | Example with sampling |
|----------|-------------------------|----------------------|
| Count events in a dataset | count() | sum(_sample_interval) |
| Sum a quantity, for example, bytes | sum(bytes) | sum(bytes * _sample_interval) |
| Average a quantity | avg(bytes) | sum(bytes * _sample_interval) / sum(_sample_interval) |
*/


function pingBucketMinutes(url) {
  const n = parseInt(url.searchParams.get('interval'), 10);
  return PING_BUCKET_MINUTES.has(n) ? n : 60;
}

function pingTimeBucketExpr(minutes) {
  return `toDateTime(
      toStartOfInterval(timestamp, INTERVAL '${minutes}' MINUTE),
      '${TIMEZONE}'
    )`;
}

async function handleAnalyticsPing(env, request) {
  const url = new URL(request.url);
  const hoursParam = url.searchParams.get('hours');
  const hours = Math.min(Math.max(parseInt(hoursParam, 10) || 24, 1), 168);
  if (isNaN(hours) || hours < 1 || hours > 168) {
    return badRequest('Invalid hours parameter');
  }
  const interval = pingBucketMinutes(url);

/*
It seems Cloudflare Analytics Engine has to record 0 instead of null for double*,
even if blob3='fail', so we must be careful with aggregations.

Problems:
- There are AvgIf() and SumIf() but not MinIf().
- There is no NullIf() function.
- Cannot do if(condition,null,value): CF-AE requires both arguments to be numbers.
- I tried using `1.0/0` to make a null: min() returned a plausible value but sum() and max() returned null.

Workaround: Use 999999.0 for min and 0.0 for max when blob3='fail'.
(Careful that they must have a decimal.)

*/
  const sql = `SELECT
    ${pingTimeBucketExpr(interval)} AS time_bucket,
    blob2 AS target,
    round(SUMIf(_sample_interval * double2, blob3 != 'fail' and double2>0) / SUMIf(_sample_interval, blob3 != 'fail' and double2>0),2) AS avg_ms,
    min(if(blob3 != 'fail' or double2=0, double2, 999999.0)) AS min_ms,
    max(if(blob3 != 'fail' or double2=0, double2, 0.0)) AS max_ms,
    SUM(_sample_interval * double4) / SUM(_sample_interval) AS avg_loss_pct,
    SUM(_sample_interval) AS sample_count,
    sumIf(_sample_interval, blob3 = 'ok' and double2>0) AS ok_count,
    sumIf(_sample_interval, blob3 = 'fail' or double2=0) AS fail_count
FROM netwatch_ping
WHERE
  timestamp > NOW() - INTERVAL '${hours}' HOUR and
  blob1='${PING_SOURCE_HOSTNAME}' and
  not blob2 in(${PING_HIDDEN_TARGETS.map(t => `'${t}'`).join(',\n    ')})
GROUP BY time_bucket, target
ORDER BY time_bucket ASC, target ASC`;

  try {
    const result = await queryAnalyticsEngine(env, sql);

    // AE SQL API returns { meta, data, rows } directly (no Cloudflare API wrapper)
    if (!result || !result.data || result.data.length === 0) {
      return new Response(JSON.stringify({ series: [], summary: [], hours, interval }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // data is already an array of objects with named keys
    const rows = result.data;

    // Pivot into series per target
    const seriesMap = {};
    for (const row of rows) {
      const target = row.target;
      if (!seriesMap[target]) {
        seriesMap[target] = {
          target,
          timestamps: [],
          avg_ms: [],
          min_ms: [],
          max_ms: [],
          avg_loss_pct: [],
          ok_count: [],
          fail_count: [],
        };
      }
      seriesMap[target].timestamps.push(row.time_bucket);
      seriesMap[target].avg_ms.push(row.avg_ms);
      seriesMap[target].min_ms.push(row.min_ms === 999999 ? null : row.min_ms); /* See problem above about nulls in min/max */
      seriesMap[target].max_ms.push(row.max_ms === 0 ? null : row.max_ms); /* See problem above about nulls in min/max */
      seriesMap[target].avg_loss_pct.push(row.avg_loss_pct);
      seriesMap[target].ok_count.push(Number(row.ok_count) || 0);
      seriesMap[target].fail_count.push(Number(row.fail_count) || 0);
    }

    const series = Object.values(seriesMap);

    // Summary per target
    const summary = series.map((s) => {
      const totalOk = s.ok_count.reduce((a, b) => a + b, 0);
      const totalFail = s.fail_count.reduce((a, b) => a + b, 0);
      const total = totalOk + totalFail;
      const avgLatency = s.avg_ms.length
        ? s.avg_ms.reduce((a, b) => a + b, 0) / s.avg_ms.length
        : 0;
      return {
        target: s.target,
        avg_ms: Math.round(avgLatency * 100) / 100,
        ok: totalOk,
        fail: totalFail,
        availability: total ? Math.round((totalOk / total) * 10000) / 100 : 0,
      };
    });

    return new Response(JSON.stringify({ series, summary, hours, interval }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    console.error(`[AnalyticsPing] Error: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

// ── Analytics: Ping Dashboard HTML ─────────────────────────────────────────
//
// GET /dashboard/ping
// Returns an HTML page with a Chart.js line chart of ping latency per target.

function handleDashboardPing() {
  let html = DASHBOARD_HTML;

  html = html.replace(
    '<script>\nfunction getColor(i, total) {',
    '<script>\nwindow.PING_TARGET_SETS = ' + JSON.stringify(PING_TARGET_SETS) + ';\n\nfunction getColor(i, total) {'
  );

  const latencyContainers = PING_TARGET_SETS.map(function(set, i) {
    return '<div class="chart-container">\n  <canvas id="latencyChart' + i + '"></canvas>\n</div>';
  }).join('\n') + '\n<div class="chart-container">\n  <canvas id="latencyChartOther"></canvas>\n</div>';

  html = html.replace(
    '<div class="chart-container">\n  <canvas id="latencyChart"></canvas>\n</div>\n<div class="chart-container">\n  <canvas id="latencyChartSlow"></canvas>\n</div>',
    latencyContainers
  );

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ── Router ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    console.log(`[Router] ${request.method} ${path}`);

    const { clientIp } = getRequestClientInfo(request);
    const allowlist = getAllowlist(env);
    if (!isIpAllowed(clientIp, allowlist)) {
      console.log(`[Router] IP ${clientIp || '(unknown)'} denied by allowlist`);
      return forbidden();
    }

    // Public GET endpoints (dashboard + analytics) - no auth required
    if (request.method === 'GET') {
      if (path === '/dashboard/ping') {
        return handleDashboardPing();
      }
      if (path === '/api/analytics/ping') {
        return handleAnalyticsPing(env, request);
      }
      // Fall through to auth-required check for unknown GET paths
    }

    // Auth check for everything else
    if (!validateAuth(request, env)) {
      console.log('[Router] Auth failed');
      return unauthorized();
    }

    console.log('[Router] Auth successful');

    // Only accept POST for data ingestion
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Parse body
    let body;
    try {
      body = await request.json();
      console.log(`[Router] Parsed JSON body for ${path}`);
    } catch {
      console.log('[Router] Failed to parse JSON body');
      return badRequest('Invalid JSON body');
    }

    // Route
    if (path === '/api/ping') {
      return handlePing(env, body, request);
    }
    if (path === '/api/speedtest') {
      return handleSpeedtest(env, body, request);
    }

    console.log(`[Router] Unknown path: ${path}`);
    return new Response('Not Found', { status: 404 });
  },
};
