/**
 * Dashboard configuration
 */


// Timezone for displaying results in dashboard.
// Does not affect how data is stored in Cloudflare Analytics Engine.
export const TIMEZONE = 'America/New_York';

// These are options on the dashboard for grouping ping data.
export const PING_BUCKET_MINUTES = new Set([15, 30, 60]);

// Even if logging from multiple hosts, the public dashboard will show
// only results from this host.
export const PING_SOURCE_HOSTNAME = 'router';

// Analytics Engine dataset name for ping data.
// Must match the `dataset` field in wrangler.toml under [[analytics_engine_datasets]].
// The `binding` name in wrangler.toml is separate and does not need to match.
export const PING_ANALYTICS_DATASET = 'netwatch_ping';

/*
If you ping some hosts that are fast and others that are slow,
the y-axis will max out at the slowest host, making it hard to see
differences in the fast hosts. To combat this, you can group targets
into sets, each with its own graph and y-axis.

Alternatively, you could group these based on function (e.g., DNS, gaming)
or location (e.g., internal, nearby regions, farther regions).
*/
export const PING_TARGET_SETS = [
  {
    label: 'CDN',
    targets: ['cloudflare.com', 'fastly.com', 'akamai.com'],
  },
];

/*
PING_HIDDEN_TARGETS: targets that will not be published
in reporting API endpoint nor shown on the dashboard.

This is useful for:
- Internal hosts that you don't want to show publicly
- Hosts that you've stopped monitoring (to avoid showing partial data)

The format is a list of string literals.
Unsupported formats include: CIDR, ranges, netmasks, and glob patterns.
*/
export const PING_HIDDEN_TARGETS = [
  // Private IPv4 addresses
  '10.0.0.1',
  '172.16.0.1',
  '192.168.0.1',

  // Loopback
  'localhost',

  // Local network hostnames (.local mDNS)
  'gateway.local',
  'router.local',
  'nas.local',
  'printer.local',
  'raspberrypi.local',
  'example-internal-host-1.local',
  'mainframe.master-bedroom.local',

  // Home network domains (.home.arpa)
  'toaster.kitchen.home.arpa',
  'home.arpa',
  'nas.home.arpa',
  'printer.home.arpa',
  'micro-hadron-collider.backyard.home.arpa',

  // Vendor-specific domains
  'pi.hole',
  'router.asus.com',
  'tplinkwifi.net',

  // Kubernetes
  'cluster.local'
];

/*
IP allowlist for incoming requests.
- Supports CIDR notation.
- Accepts a list of IPv4 or IPv6 addresses.
- Can be overridden by the IP_ALLOWLIST environment variable (comma-separated)
  in which case the value in this file is ignored.
- This has no effect on posting measurements to the API (which uses a shared secret).

// Example: allows all IPv4 and IPv6 addresses.
//export const IP_ALLOWLIST = ['0.0.0.0/0', '::/0'];

// Example: allow one IP. (You would use a public IP)
//export const IP_ALLOWLIST = ['192.168.1.100'];

// Example: allow two net ranges.
//export const IP_ALLOWLIST = ['192.0.2.0/24', '2001:db8::/32'];

// Example: restrict all (disable dashboard).
//export const IP_ALLOWLIST = [];

// Default: allow these two IPs only.
*/

export const IP_ALLOWLIST = [
  '192.0.2.1',
  '192.0.2.2'
];
