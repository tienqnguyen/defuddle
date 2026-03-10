import { parseHTML } from 'linkedom';
import Defuddle from 'defuddle';
import TurndownService from 'turndown';

const MAX_SIZE = 5 * 1024 * 1024; // 5MB

const X_URL_PATTERN = /^https?:\/\/(x\.com|twitter\.com)\/\w+\/status\/\d+/;

// ─── FxTwitter API Types ────────────────────────────────────────────────────

interface FxAuthor {
    id: string;
    name: string;
    screen_name: string;
    avatar_url?: string;
    banner_url?: string;
    description?: string;
    followers?: number;
    following?: number;
}

interface FxPhoto {
    type: 'photo';
    url: string;
    width: number;
    height: number;
    altText?: string;
}

interface FxVideo {
    type: 'video' | 'gif';
    url: string;
    thumbnail_url: string;
    width: number;
    height: number;
    duration: number;
    format?: string;
}

interface FxExternalMedia {
    type: 'video';
    url: string;
    thumbnail_url?: string;
    height?: number;
    width?: number;
}

interface FxBroadcast {
    url: string;
    width: number;
    height: number;
    state: 'LIVE' | 'ENDED';
    broadcaster: { username: string; display_name: string; id: string };
    title: string;
    broadcast_id: string;
    stream?: { url: string };
}

interface FxPollChoice {
    label: string;
    count: number;
    percentage: number;
}

interface FxPoll {
    choices: FxPollChoice[];
    total_votes: number;
    ends_at?: string;
    time_left_en?: string;
}

interface FxFacet {
    type: string;
    indices: [number, number];
    original?: string;
    replacement?: string;
    display?: string;
    id?: string;
}

interface FxCommunityNote {
    text: string;
}

interface FxMedia {
    type: string;
    url: string;
    width?: number;
    height?: number;
}

interface FxArticleMediaEntity {
    media_id?: string;
    media_key?: string;
    media_info?: {
        __typename?: string;
        original_img_url?: string;
        original_img_width?: number;
        original_img_height?: number;
        color_info?: any;
        video_info?: {
            variants?: { bitrate?: number; content_type?: string; url?: string }[];
            duration_millis?: number;
            aspect_ratio?: number[];
        };
    };
    url?: string;
    type?: string;
}

interface FxArticle {
    id: string;
    title: string;
    preview_text: string;
    cover_media?: FxArticleMediaEntity;
    content: {
        blocks: DraftBlock[];
        entityMap: Record<string, DraftEntity>;
    };
    media_entities?: FxArticleMediaEntity[];
    created_at?: string;
    modified_at?: string;
}

interface DraftBlock {
    type: string;
    text: string;
    inlineStyleRanges: { offset: number; length: number; style: string }[];
    entityRanges: { offset: number; length: number; key: number }[];
    data?: Record<string, any>;
}

interface DraftEntity {
    type?: string;
    mutability?: string;
    data?: Record<string, any>;
    value?: {
        type?: string;
        mutability?: string;
        data?: Record<string, any>;
    };
}

function getEntityInfo(entity: DraftEntity): { type: string; data: Record<string, any> } {
    const type = (entity.value?.type || entity.type || '').toUpperCase();
    const data = entity.value?.data || entity.data || {};
    return { type, data };
}

interface FxTweet {
    id: string;
    url: string;
    text: string;
    created_at: string;
    created_timestamp?: number;
    author: FxAuthor;
    likes: number;
    retweets: number;
    replies: number;
    views?: number | null;
    bookmarks?: number | null;
    media?: {
        photos?: FxPhoto[];
        videos?: FxVideo[];
        all?: FxMedia[];
        external?: FxExternalMedia;
        mosaic?: FxMedia;
        broadcast?: FxBroadcast;
    };
    quote?: FxTweet;
    poll?: FxPoll;
    article?: FxArticle;
    raw_text?: {
        text: string;
        facets: FxFacet[];
    };
    replying_to?: { screen_name: string; post: string } | null;
    community_note?: FxCommunityNote | null;
    is_note_tweet?: boolean;
    lang?: string | null;
    source?: string | null;
    possibly_sensitive?: boolean;
}

// ─── Result Interface ───────────────────────────────────────────────────────

export interface ConvertResult {
    title: string;
    author: string;
    published: string;
    description: string;
    domain: string;
    content: string;
    wordCount: number;
    source: string;
    favicon?: string;
    image?: string;
    site?: string;
    likes?: number;
    retweets?: number;
    replies?: number;
    views?: number | null;
}

// ─── URL Helpers ────────────────────────────────────────────────────────────

function isXUrl(url: string): boolean {
    return X_URL_PATTERN.test(url);
}

function parseTweetUrl(url: string): { username: string; tweetId: string } | null {
    const match = url.match(/^https?:\/\/(?:x\.com|twitter\.com)\/(\w+)\/status\/(\d+)/);
    if (!match) return null;
    return { username: match[1], tweetId: match[2] };
}

// ─── CSS Selector Extractor ─────────────────────────────────────────────────

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the first HTML fragment matching a simple CSS selector.
 * Supports: tag, .class, #id, and combinations (e.g. div.foo, table#main.bar).
 * Uses depth-aware walker to correctly handle nested same-tag elements.
 * Flags: 'i' (case-insensitive) + 's' (dotall, handles multiline attributes).
 */
function extractBySelector(html: string, selector: string): string | null {
    const token = selector.trim();

    const tagMatch     = token.match(/^([a-z][a-z0-9]*)/i);
    const idMatch      = token.match(/#([a-z][a-z0-9_-]*)/i);
    const classMatches = [...token.matchAll(/\.([a-z][a-z0-9_-]*)/gi)];

    const tag     = tagMatch ? tagMatch[1] : '[a-z][a-z0-9]*';
    const id      = idMatch  ? idMatch[1]  : null;
    const classes = classMatches.map(m => m[1]);

    // id lookahead — handles both quote styles and surrounding attributes
    const idLook = id
        ? `(?=[^>]*(?:\\s|^)id=["']${escapeRegex(id)}["'])`
        : '';

    // class lookahead — each class must appear as a whole word within class="..."
    const classLooks = classes.map(cls =>
        `(?=[^>]*(?:\\s|^)class=["'][^"']*(?:^|\\s)${escapeRegex(cls)}(?:\\s|$)[^"']*["'])`
    ).join('');

    const openTagRe = new RegExp(
        `<(${tag})${idLook}${classLooks}(?:\\s[^>]*)?>`,
        'is'  // i = case-insensitive, s = dotall for multiline attributes
    );

    const startMatch = openTagRe.exec(html);
    if (!startMatch) return null;

    const matchedTag = startMatch[1].toLowerCase();
    const startIdx   = startMatch.index;
    let pos          = startIdx + startMatch[0].length;

    // Void elements have no closing tag — return the tag itself
    const VOID_TAGS = new Set([
        'area', 'base', 'br', 'col', 'embed', 'hr',
        'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
    ]);
    if (VOID_TAGS.has(matchedTag)) {
        return html.slice(startIdx, pos);
    }

    // Depth-aware walk to find the correct closing tag
    let depth = 1;
    const openRe  = new RegExp(`<${matchedTag}(?:\\s[^>]*)?>`,  'gi');
    const closeRe = new RegExp(`<\\/${matchedTag}\\s*>`,         'gi');

    while (depth > 0 && pos < html.length) {
        openRe.lastIndex  = pos;
        closeRe.lastIndex = pos;

        const nextOpen  = openRe.exec(html);
        const nextClose = closeRe.exec(html);

        if (!nextClose) break; // malformed HTML — return what we have

        if (nextOpen && nextOpen.index < nextClose.index) {
            depth++;
            pos = nextOpen.index + nextOpen[0].length;
        } else {
            depth--;
            pos = nextClose.index + nextClose[0].length;
        }
    }

    return html.slice(startIdx, pos);
}

// ─── DraftJS → Markdown ─────────────────────────────────────────────────────

function applyInlineStyles(text: string, ranges: DraftBlock['inlineStyleRanges']): string {
    if (!ranges.length) return text;
    const sorted = [...ranges].sort((a, b) => b.offset - a.offset);
    let result = text;
    for (const range of sorted) {
        const before  = result.slice(0, range.offset);
        const segment = result.slice(range.offset, range.offset + range.length);
        const after   = result.slice(range.offset + range.length);
        switch (range.style) {
            case 'Bold':
            case 'BOLD':          result = before + `**${segment}**`  + after; break;
            case 'Italic':
            case 'ITALIC':        result = before + `*${segment}*`    + after; break;
            case 'Code':
            case 'CODE':          result = before + `\`${segment}\``  + after; break;
            case 'Strikethrough':
            case 'STRIKETHROUGH': result = before + `~~${segment}~~`  + after; break;
        }
    }
    return result;
}

function applyEntityLinks(
    text: string,
    entityRanges: DraftBlock['entityRanges'],
    entityMap: Record<string, DraftEntity>
): string {
    if (!entityRanges.length) return text;
    const sorted = [...entityRanges].sort((a, b) => b.offset - a.offset);
    let result = text;
    for (const range of sorted) {
        const entity = entityMap[range.key];
        if (!entity) continue;
        const before  = result.slice(0, range.offset);
        const segment = result.slice(range.offset, range.offset + range.length);
        const after   = result.slice(range.offset + range.length);
        const { type: entityType, data } = getEntityInfo(entity);
        if (entityType === 'LINK' || entityType === 'URL') {
            const url = data.url || data.href || '';
            if (url) result = before + `[${segment}](${url})` + after;
        } else if (entityType === 'MENTION' || entityType === 'AT_MENTION') {
            const screenName = data.screenName || data.screen_name || segment.replace('@', '');
            result = before + `[@${screenName}](https://x.com/${screenName})` + after;
        } else if (entityType === 'HASHTAG') {
            const tag = data.hashtag || segment.replace('#', '');
            result = before + `[#${tag}](https://x.com/hashtag/${tag})` + after;
        }
    }
    return result;
}

function resolveArticleMediaUrl(
    mediaId: string,
    mediaEntities: FxArticleMediaEntity[]
): { url: string; type: 'image' | 'video' } | null {
    const entity = mediaEntities.find(m => m.media_id === mediaId || m.media_key === mediaId);
    if (!entity) return null;
    const info = entity.media_info;
    if (!info) {
        if (entity.url) return { url: entity.url, type: entity.type === 'video' ? 'video' : 'image' };
        return null;
    }
    if (info.__typename === 'ApiImage' || info.original_img_url) {
        return { url: info.original_img_url!, type: 'image' };
    }
    if (info.__typename === 'ApiVideo' || info.video_info) {
        const variants = info.video_info?.variants || [];
        const mp4s     = variants.filter(v => v.content_type === 'video/mp4' && v.url);
        const best     = mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (best?.url) return { url: best.url, type: 'video' };
        const any = variants.find(v => v.url);
        if (any?.url) return { url: any.url, type: 'video' };
    }
    return null;
}

function blocksToMarkdown(
    blocks: DraftBlock[],
    entityMap: Record<string, DraftEntity>,
    mediaEntities: FxArticleMediaEntity[] = []
): string {
    const lines: string[] = [];
    for (const block of blocks) {
        let text = applyEntityLinks(block.text || '', block.entityRanges || [], entityMap);
        text = applyInlineStyles(text, block.inlineStyleRanges || []);
        switch (block.type) {
            case 'header-one':          lines.push(`# ${text}`);   break;
            case 'header-two':          lines.push(`## ${text}`);  break;
            case 'header-three':        lines.push(`### ${text}`); break;
            case 'unordered-list-item': lines.push(`- ${text}`);   break;
            case 'ordered-list-item':   lines.push(`1. ${text}`);  break;
            case 'blockquote':          lines.push(`> ${text}`);   break;
            case 'code-block':          lines.push('```\n' + block.text + '\n```'); break;
            case 'atomic': {
                for (const range of block.entityRanges || []) {
                    const entity = entityMap[range.key];
                    if (!entity) continue;
                    const { type: entityType, data } = getEntityInfo(entity);
                    if (data.markdown) { lines.push(data.markdown); continue; }
                    if (entityType === 'MEDIA') {
                        for (const item of (data.mediaItems || [])) {
                            const mediaId = item.mediaId || item.media_id || '';
                            if (!mediaId) continue;
                            const resolved = resolveArticleMediaUrl(mediaId, mediaEntities);
                            if (resolved) {
                                lines.push(resolved.type === 'image'
                                    ? `![](${resolved.url})`
                                    : `[Video](${resolved.url})`);
                            }
                        }
                        continue;
                    }
                    if (entityType === 'MARKDOWN') {
                        const code = data.markdown || data.content || '';
                        const lang = data.language || '';
                        if (code) lines.push('```' + lang + '\n' + code + '\n```');
                        continue;
                    }
                    if (entityType === 'TWEET' || entityType === 'EMBEDDED_TWEET') {
                        const tweetId = data.id || data.tweetId || '';
                        if (tweetId) lines.push(`> [Embedded Tweet](https://x.com/i/status/${tweetId})`);
                        continue;
                    }
                    if (entityType === 'IMAGE' || entityType === 'PHOTO') {
                        const url = data.src || data.url || '';
                        if (url) lines.push(`![${data.alt || data.altText || ''}](${url})`);
                        continue;
                    }
                    if (entityType === 'VIDEO') {
                        const url = data.src || data.url || '';
                        if (url) lines.push(`[Video](${url})`);
                        continue;
                    }
                }
                break;
            }
            default: lines.push(text); break;
        }
    }
    return lines.join('\n\n');
}

// ─── Tweet Text Processing ──────────────────────────────────────────────────

function expandTweetText(tweet: FxTweet): string {
    if (!tweet.raw_text?.facets?.length) return tweet.text || '';
    const { text, facets } = tweet.raw_text;
    const chars = [...text];
    let result = '';
    let lastIndex = 0;
    const sorted = [...facets].sort((a, b) => a.indices[0] - b.indices[0]);
    for (const facet of sorted) {
        const [start, end] = facet.indices;
        result += chars.slice(lastIndex, start).join('');
        const originalSegment = chars.slice(start, end).join('');
        if (facet.type === 'url' && facet.display) {
            const linkUrl = facet.replacement || facet.original || originalSegment;
            result += `[${facet.display}](${linkUrl})`;
        } else if (facet.type === 'mention') {
            const screenName = facet.id || originalSegment.replace('@', '');
            result += `[@${screenName}](https://x.com/${screenName})`;
        } else if (facet.type === 'hashtag') {
            const tag = facet.display || originalSegment.replace('#', '');
            result += `[#${tag}](https://x.com/hashtag/${tag})`;
        } else {
            result += originalSegment;
        }
        lastIndex = end;
    }
    result += chars.slice(lastIndex).join('');
    return result;
}

// ─── Media Rendering ────────────────────────────────────────────────────────

function renderMedia(media: FxTweet['media'], indent = ''): string {
    if (!media) return '';
    const parts: string[] = [];
    if (media.photos?.length) {
        for (const photo of media.photos) {
            parts.push(`${indent}![${photo.altText || ''}](${photo.url})`);
        }
    }
    if (media.videos?.length) {
        for (const video of media.videos) {
            const label = video.type === 'gif' ? 'GIF' : 'Video';
            const dur   = video.duration > 0 ? ` (${formatDuration(video.duration)})` : '';
            parts.push(`${indent}[${label}${dur}](${video.url})`);
            if (video.thumbnail_url) parts.push(`${indent}![Thumbnail](${video.thumbnail_url})`);
        }
    }
    if (media.external) {
        parts.push(`${indent}[External Video](${media.external.url})`);
    }
    if (media.broadcast) {
        const bc         = media.broadcast;
        const stateLabel = bc.state === 'LIVE' ? '🔴 LIVE' : '⏹ Ended';
        parts.push(`${indent}**${stateLabel}: ${bc.title}** by @${bc.broadcaster.username}`);
        parts.push(bc.stream?.url
            ? `${indent}[Watch Stream](${bc.stream.url})`
            : `${indent}[Watch Broadcast](${bc.url})`);
    }
    if (!parts.length && media.all?.length) {
        for (const m of media.all) {
            if (m.type === 'photo') parts.push(`${indent}![](${m.url})`);
            else if (m.type === 'video' || m.type === 'gif') parts.push(`${indent}[Video](${m.url})`);
        }
    }
    return parts.length ? '\n\n' + parts.join('\n\n') : '';
}

function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins > 0 ? `${mins}m${secs.toString().padStart(2, '0')}s` : `${secs}s`;
}

// ─── Quote / Poll / Engagement ──────────────────────────────────────────────

function renderQuote(quote: FxTweet): string {
    const qAuthor = quote.author?.name || '';
    const qHandle = quote.author?.screen_name || '';
    const qUrl    = quote.url || `https://x.com/${qHandle}/status/${quote.id}`;
    let content   = `> **${qAuthor}** ([@${qHandle}](https://x.com/${qHandle})):`;
    const qText   = expandTweetText(quote);
    if (qText) content += '\n> \n' + qText.split('\n').map(l => `> ${l}`).join('\n');
    const qMedia  = renderMedia(quote.media, '> ');
    if (qMedia) content += qMedia;
    content += `\n>\n> [View original](${qUrl})`;
    return content;
}

function renderPoll(poll: FxPoll): string {
    let content = '\n\n📊 **Poll:**';
    for (const c of poll.choices) {
        const bar = '█'.repeat(Math.round(c.percentage / 5)) + '░'.repeat(20 - Math.round(c.percentage / 5));
        content += `\n- ${c.label}: ${bar} ${c.percentage}% (${c.count.toLocaleString()} votes)`;
    }
    content += `\n- **Total votes:** ${poll.total_votes.toLocaleString()}`;
    if (poll.time_left_en) content += ` · ${poll.time_left_en}`;
    else if (poll.ends_at) content += ` · Ends: ${poll.ends_at}`;
    return content;
}

function renderEngagement(tweet: FxTweet): string {
    const parts: string[] = [];
    if (tweet.likes     != null) parts.push(`❤️ ${tweet.likes.toLocaleString()}`);
    if (tweet.retweets  != null) parts.push(`🔁 ${tweet.retweets.toLocaleString()}`);
    if (tweet.replies   != null) parts.push(`💬 ${tweet.replies.toLocaleString()}`);
    if (tweet.views     != null) parts.push(`👁 ${tweet.views.toLocaleString()}`);
    if (tweet.bookmarks != null) parts.push(`🔖 ${tweet.bookmarks.toLocaleString()}`);
    return parts.length ? '\n\n---\n' + parts.join(' · ') : '';
}

// ─── Tweet Fetcher ──────────────────────────────────────────────────────────

async function fetchTweetData(url: string): Promise<ConvertResult> {
    const parsed = parseTweetUrl(url);
    if (!parsed) throw new Error('Invalid X/Twitter URL');

    const apiUrl   = `https://api.fxtwitter.com/${parsed.username}/status/${parsed.tweetId}`;
    const response = await fetch(apiUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DefuddleWorker/1.0)' },
    });
    if (!response.ok) throw new Error(`FxTwitter API error: ${response.status}`);

    const data  = await response.json() as { tweet?: FxTweet };
    const tweet = data.tweet;
    if (!tweet) throw new Error('Tweet not found');

    let content     = '';
    let title       = '';
    let description = '';

    if (tweet.replying_to?.screen_name) {
        content += `*Replying to [@${tweet.replying_to.screen_name}](https://x.com/${tweet.replying_to.screen_name})*\n\n`;
    }

    if (tweet.article?.content?.blocks) {
        const article       = tweet.article;
        title               = article.title || '';
        description         = article.preview_text || '';
        const coverUrl      = article.cover_media?.media_info?.original_img_url || article.cover_media?.url;
        if (coverUrl) content += `![Cover](${coverUrl})\n\n`;

        const blocks        = article.content.blocks;
        const rawEntityMap  = article.content.entityMap;
        const mediaEntities = article.media_entities || [];

        let entityMap: Record<string, DraftEntity>;
        if (Array.isArray(rawEntityMap)) {
            entityMap = {};
            for (const entry of rawEntityMap as any[]) {
                const key = String(entry.key ?? entry.index ?? '');
                entityMap[key] = entry.value ?? entry;
            }
        } else {
            entityMap = rawEntityMap || {};
        }

        content += blocksToMarkdown(blocks, entityMap, mediaEntities);
    } else {
        content     = expandTweetText(tweet);
        description = (tweet.text || '').slice(0, 200);
    }

    content += renderMedia(tweet.media);
    if (tweet.quote) content += '\n\n' + renderQuote(tweet.quote);
    if (tweet.poll)  content += renderPoll(tweet.poll);
    if (tweet.community_note?.text) {
        content += '\n\n> [!NOTE] **Community Note**\n> '
            + tweet.community_note.text.split('\n').join('\n> ');
    }
    content += renderEngagement(tweet);

    const authorName   = tweet.author?.name || '';
    const authorHandle = tweet.author?.screen_name || '';

    return {
        title:       title || `${authorName} (@${authorHandle})`,
        author:      `${authorName} (@${authorHandle})`,
        published:   tweet.created_at || '',
        description,
        domain:      'x.com',
        content,
        wordCount:   content.split(/\s+/).filter(Boolean).length,
        source:      url,
        image:       tweet.author?.avatar_url || undefined,
        likes:       tweet.likes,
        retweets:    tweet.retweets,
        replies:     tweet.replies,
        views:       tweet.views,
    };
}

// ─── Regular Web Page Parser ────────────────────────────────────────────────

async function fetchAndParse(
    targetUrl: string,
    selector: string | null = null
): Promise<ConvertResult> {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 10_000);

    let response: Response;
    try {
        response = await fetch(targetUrl, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; DefuddleWorker/1.0)',
                'Accept':     'text/html,application/xhtml+xml',
            },
            redirect: 'follow',
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        throw new Error(`Not an HTML page (content-type: ${contentType})`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_SIZE) {
        throw new Error(`Page too large (${Math.round(parseInt(contentLength) / 1024 / 1024)}MB, max 5MB)`);
    }

    const html = await response.text();
    if (html.length > MAX_SIZE) {
        throw new Error(`Page too large (${Math.round(html.length / 1024 / 1024)}MB, max 5MB)`);
    }

    // ── Selector path: extract fragment → Turndown directly (skip Defuddle) ──
    if (selector) {
        const fragment = extractBySelector(html, selector);
        if (!fragment) {
            throw new Error(`Selector "${selector}" matched no elements.`);
        }

        const turndown = new TurndownService({
            headingStyle:   'atx',
            codeBlockStyle: 'fenced',
        });
        const markdown = turndown.turndown(fragment);

        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const pageTitle  = titleMatch ? titleMatch[1].trim() : '';
        const domain     = new URL(targetUrl).hostname.replace(/^www\./, '');

        return {
            title:       pageTitle,
            author:      '',
            published:   '',
            description: '',
            domain,
            content:     markdown,
            wordCount:   markdown.split(/\s+/).filter(Boolean).length,
            source:      targetUrl,
        };
    }

    // ── Full page path: Defuddle → Turndown ──────────────────────────────────
    const { document } = parseHTML(html);

    const doc = document as any;
    if (!doc.styleSheets) doc.styleSheets = [];
    if (doc.defaultView && !doc.defaultView.getComputedStyle) {
        doc.defaultView.getComputedStyle = () => ({ display: '' });
    }

    const defuddle = new Defuddle(document as any, { url: targetUrl });
    const result   = defuddle.parse();

    const turndown = new TurndownService({
        headingStyle:   'atx',
        codeBlockStyle: 'fenced',
    });
    const markdown = turndown.turndown(result.content || '');

    return {
        title:       result.title       || '',
        author:      result.author      || '',
        published:   result.published   || '',
        description: result.description || '',
        domain:      result.domain      || '',
        content:     markdown,
        wordCount:   result.wordCount   || 0,
        source:      targetUrl,
        favicon:     result.favicon,
        image:       result.image,
        site:        result.site,
    };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function convertToMarkdown(
    targetUrl: string,
    options?: { selector?: string | null }
): Promise<ConvertResult> {
    if (isXUrl(targetUrl)) {
        return fetchTweetData(targetUrl); // selector N/A for tweets
    }
    return fetchAndParse(targetUrl, options?.selector ?? null);
}

export function formatResponse(result: ConvertResult, targetUrl?: string): string {
    const frontmatter: string[] = ['---'];
    if (result.title)       frontmatter.push(`title: "${result.title.replace(/"/g, '\\"')}"`);
    if (result.author)      frontmatter.push(`author: "${result.author.replace(/"/g, '\\"')}"`);
    if (result.published)   frontmatter.push(`published: ${result.published}`);
    frontmatter.push(`source: "${result.source}"`);
    if (result.domain)      frontmatter.push(`domain: "${result.domain}"`);
    if (result.description) frontmatter.push(`description: "${result.description.replace(/"/g, '\\"')}"`);
    if (result.wordCount)   frontmatter.push(`word_count: ${result.wordCount}`);
    if (result.likes    != null) frontmatter.push(`likes: ${result.likes}`);
    if (result.retweets != null) frontmatter.push(`retweets: ${result.retweets}`);
    if (result.replies  != null) frontmatter.push(`replies: ${result.replies}`);
    if (result.views    != null) frontmatter.push(`views: ${result.views}`);
    frontmatter.push('---');
    return frontmatter.join('\n') + '\n\n' + result.content;
}
