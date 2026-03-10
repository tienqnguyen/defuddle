import './polyfill';
import { convertToMarkdown, formatResponse } from './convert';

const BLOCKED_HOSTS =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::1|::ffff:127\.|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ── /api/convert endpoint (for frontend) ──
    if (path === '/api/convert' && request.method === 'POST') {
      try {
        const body = await request.json() as { url?: string; selector?: string };
        const targetUrl = body?.url?.trim();
        const selector  = body?.selector?.trim() || null;

        if (!targetUrl) {
          return jsonError('Missing "url" field in request body.', 400);
        }

        let parsedTarget: URL;
        try {
          parsedTarget = new URL(targetUrl);
        } catch {
          return jsonError('Invalid URL. Please provide a valid web address.', 400);
        }

        if (BLOCKED_HOSTS.test(parsedTarget.hostname)) {
          return jsonError('Cannot convert this URL.', 400);
        }

        const result = await convertToMarkdown(targetUrl, { selector });
        return new Response(JSON.stringify(result, null, 2), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...CORS_HEADERS,
            'Cache-Control': 'public, max-age=3600',
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred';
        return jsonError(message, 502);
      }
    }

    // ── Static / favicon guards ──
    if (path === '/' || path === '') {
      return new Response(null, { status: 404 });
    }
    if (path === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    // ── URL conversion endpoint (GET /{url}?selector=.className) ──
    let targetUrl = decodeURIComponent(path.slice(1));

    if (
      targetUrl.endsWith('.js')  || targetUrl.endsWith('.css') ||
      targetUrl.endsWith('.png') || targetUrl.endsWith('.svg') ||
      targetUrl.endsWith('.ico')
    ) {
      return new Response(null, { status: 404 });
    }

    // Pull ?selector= before appending the rest of the query string to targetUrl
    const selector = url.searchParams.get('selector')?.trim() || null;

    // Re-build query string without the selector param so it doesn't pollute the target URL
    const forwardParams = new URLSearchParams(url.search);
    forwardParams.delete('selector');
    const forwardSearch = forwardParams.toString();
    if (forwardSearch) {
      targetUrl += '?' + forwardSearch;
    }

    // Prepend https:// if no protocol
    if (!targetUrl.match(/^https?:\/\//)) {
      targetUrl = 'https://' + targetUrl;
    }

    // Validate URL
    let parsedTarget: URL;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return errorResponse('Invalid URL. Please provide a valid web address.', 400);
    }

    if (BLOCKED_HOSTS.test(parsedTarget.hostname)) {
      return errorResponse('Cannot convert this URL.', 400);
    }

    try {
      const result = await convertToMarkdown(targetUrl, { selector });

      const accept = request.headers.get('Accept') || '';
      if (accept.includes('application/json')) {
        return new Response(JSON.stringify(result, null, 2), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...CORS_HEADERS,
            'Cache-Control': 'public, max-age=3600',
          },
        });
      }

      const markdown = formatResponse(result, targetUrl);
      return new Response(markdown, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          ...CORS_HEADERS,
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred';
      return errorResponse(message, 502);
    }
  },
} satisfies ExportedHandler;

// ── Helpers ──────────────────────────────────────────────────────────────────

function errorResponse(message: string, status: number): Response {
  return new Response(`Error: ${message}`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}
