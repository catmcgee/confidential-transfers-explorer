import type { CTDatabase } from './db/database.js';

/**
 * Simple HTTP API server that exposes the indexer's database for the web service.
 * Runs alongside the indexer process.
 */
export function startApiServer(db: CTDatabase, port: number = 3001): void {
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS headers for Railway internal networking
      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      };

      try {
        // GET /health
        if (path === '/health') {
          return new Response(JSON.stringify({ status: 'ok' }), { headers });
        }

        // GET /api/feed?limit=50&cursor=123&type=Transfer
        if (path === '/api/feed') {
          const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
          const cursorParam = url.searchParams.get('cursor');
          const cursor = cursorParam ? parseInt(cursorParam, 10) : undefined;
          const type = url.searchParams.get('type') ?? undefined;

          const result = db.getFeed(limit, cursor, type);
          return new Response(JSON.stringify(result), { headers });
        }

        // GET /api/activity?address=xxx&limit=50&cursor=123&type=Transfer
        if (path === '/api/activity') {
          const address = url.searchParams.get('address');
          if (!address) {
            return new Response(JSON.stringify({ error: 'address required' }), {
              status: 400,
              headers,
            });
          }
          const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
          const cursorParam = url.searchParams.get('cursor');
          const cursor = cursorParam ? parseInt(cursorParam, 10) : undefined;
          const type = url.searchParams.get('type') ?? undefined;

          const result = db.getActivityByAddress(address, limit, cursor, type);
          return new Response(JSON.stringify(result), { headers });
        }

        // GET /api/tx?signature=xxx
        if (path === '/api/tx') {
          const signature = url.searchParams.get('signature');
          if (!signature) {
            return new Response(JSON.stringify({ error: 'signature required' }), {
              status: 400,
              headers,
            });
          }
          const activities = db.getActivitiesBySignature(signature);
          return new Response(JSON.stringify({ activities }), { headers });
        }

        // GET /api/search?q=xxx&limit=10
        if (path === '/api/search') {
          const q = url.searchParams.get('q');
          if (!q) {
            return new Response(JSON.stringify({ error: 'q required' }), {
              status: 400,
              headers,
            });
          }
          const limit = parseInt(url.searchParams.get('limit') ?? '10', 10);
          const activities = db.search(q, limit);
          return new Response(JSON.stringify({ activities }), { headers });
        }

        // GET /api/mints
        if (path === '/api/mints') {
          const mints = db.getMints();
          return new Response(JSON.stringify({ mints }), { headers });
        }

        // GET /api/mint?address=xxx
        if (path === '/api/mint') {
          const address = url.searchParams.get('address');
          if (!address) {
            return new Response(JSON.stringify({ error: 'address required' }), {
              status: 400,
              headers,
            });
          }
          const mint = db.getMint(address);
          return new Response(JSON.stringify({ mint }), { headers });
        }

        // GET /api/token-accounts?owner=xxx
        if (path === '/api/token-accounts') {
          const owner = url.searchParams.get('owner');
          if (!owner) {
            return new Response(JSON.stringify({ error: 'owner required' }), {
              status: 400,
              headers,
            });
          }
          const accounts = db.getTokenAccountsByOwner(owner);
          return new Response(JSON.stringify({ accounts }), { headers });
        }

        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers,
        });
      } catch (err) {
        console.error('[API] Error:', err);
        return new Response(JSON.stringify({ error: 'internal error' }), {
          status: 500,
          headers,
        });
      }
    },
  });

  console.log(`[API] Server listening on port ${server.port}`);
}
