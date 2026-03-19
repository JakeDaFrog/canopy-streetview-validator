/**
 * Cloudflare Worker — Street View History Proxy
 *
 * Proxies requests to Google's GeoPhotoService.SingleImageSearch endpoint,
 * which requires a server-side origin to avoid CORS errors in the browser.
 *
 * Deploy instructions are in the project README.
 */

const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/(localhost(:\d+)?|.+\.github\.io)$/;
const GOOGLE_HISTORY_BASE    = 'https://maps.googleapis.com/maps/api/js/GeoPhotoService.SingleImageSearch';
const WAYBACK_CONFIG_URL     = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '*';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url    = new URL(request.url);
    const action = url.searchParams.get('action');

    // ── Route: ESRI Wayback release config ──────────────────────────────────
    if (action === 'wayback-config') {
      let resp;
      try {
        resp = await fetch(WAYBACK_CONFIG_URL);
      } catch (err) {
        return new Response(`Upstream fetch failed: ${err.message}`, { status: 502, headers: corsHeaders(origin) });
      }
      const body = await resp.text();
      return new Response(body, {
        status: resp.status,
        headers: {
          'Content-Type':  'application/json;charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          ...corsHeaders(origin),
        },
      });
    }

    // ── Route: Google Street View history (existing) ─────────────────────────
    const pb = url.searchParams.get('pb');
    if (!pb) {
      return new Response('Missing required "pb" or "action" query parameter', { status: 400 });
    }

    let googleResp;
    try {
      googleResp = await fetch(`${GOOGLE_HISTORY_BASE}?pb=${encodeURIComponent(pb)}`, {
        headers: {
          'Referer':    'https://www.google.com/maps',
          'Accept':     '*/*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
    } catch (err) {
      return new Response(`Upstream fetch failed: ${err.message}`, { status: 502 });
    }

    const body = await googleResp.text();
    return new Response(body, {
      status: googleResp.status,
      headers: {
        'Content-Type':  'text/plain;charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        ...corsHeaders(origin),
      },
    });
  },
};

function corsHeaders(origin) {
  // Allow any github.io subdomain or localhost during development
  const allow = ALLOWED_ORIGIN_PATTERN.test(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}
