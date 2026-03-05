import './polyfill';
import { convertToMarkdown, formatResponse } from './convert';

const BLOCKED_HOSTS = ['localhost'];

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Landing / usage page
    if (path === '/' || path === '') {
      return new Response(
        'Defuddle Worker\n\nGet the main content of any page as Markdown.\n\nUsage:\n  curl <this-worker>/example.com\n  curl <this-worker>/x.com/user/status/123\n',
        {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
          },
        }
      );
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // favicon
    if (path === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    // Parse target URL from path
    let targetUrl = decodeURIComponent(path.slice(1));

    // Append query string if present
    if (url.search) {
      targetUrl += url.search;
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

    // Block self-referential requests
    if (BLOCKED_HOSTS.some(host => parsedTarget.hostname.includes(host))) {
      return errorResponse('Cannot convert this URL.', 400);
    }

    try {
      const result = await convertToMarkdown(targetUrl);

      // Check Accept header for JSON output
      const accept = request.headers.get('Accept') || '';
      if (accept.includes('application/json')) {
        return new Response(JSON.stringify(result, null, 2), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600',
          },
        });
      }

      // Default: return markdown
      const markdown = formatResponse(result, targetUrl);

      return new Response(markdown, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred';
      return errorResponse(message, 502);
    }
  },
} satisfies ExportedHandler;

function errorResponse(message: string, status: number): Response {
  return new Response(`Error: ${message}`, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
