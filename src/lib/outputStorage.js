import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Hosts MuAPI serves generated results from. Extra hosts (e.g. a provider CDN a new model returns)
// can be allowed without a rebuild through OUTPUT_ALLOWED_HOSTS (comma separated, exact names).
const DEFAULT_ALLOWED_HOSTS = ['cdn.muapi.ai', 'd3adwkbyhxyrtq.cloudfront.net'];
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), 'output');
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_URLS_PER_REQUEST = 16;
const MAX_MODEL_SLUG_LENGTH = 60;
const OUTPUT_TIME_ZONE = process.env.OUTPUT_TIME_ZONE || 'Africa/Algiers';

const EXTENSIONS_BY_TYPE = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
};
const ALLOWED_EXTENSIONS = new Set(Object.values(EXTENSIONS_BY_TYPE));

export class OutputError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

export function getOutputDir() {
    return process.env.OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
}

function getAllowedHosts() {
    const extra = (process.env.OUTPUT_ALLOWED_HOSTS || '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean);
    return new Set([...DEFAULT_ALLOWED_HOSTS, ...extra]);
}

export function validateOutputUrl(rawUrl) {
    let url;
    try {
        url = new URL(String(rawUrl));
    } catch {
        throw new OutputError('invalid_url', 400);
    }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
        throw new OutputError('invalid_url', 400);
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!getAllowedHosts().has(hostname)) {
        throw new OutputError(`host_not_allowed: ${hostname}`, 400);
    }
    return url;
}

// Redirects are followed by hand so that every hop is checked against the allow-list (no SSRF through a 3xx).
async function fetchAllowed(url) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await fetch(current, { redirect: 'manual' });
        if (response.status < 300 || response.status >= 400) return response;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new OutputError('redirect_without_location', 502);
        current = validateOutputUrl(new URL(location, current));
    }
    throw new OutputError('too_many_redirects', 502);
}

function resolveExtension(contentType, url) {
    const mime = (contentType || '').split(';')[0].trim().toLowerCase();
    if (EXTENSIONS_BY_TYPE[mime]) return EXTENSIONS_BY_TYPE[mime];
    const fromPath = path.extname(url.pathname).slice(1).toLowerCase();
    const normalized = fromPath === 'jpeg' ? 'jpg' : fromPath;
    if (ALLOWED_EXTENSIONS.has(normalized)) return normalized;
    throw new OutputError(`unsupported_media_type: ${mime || 'unknown'}`, 415);
}

function mediaKind(extension) {
    if (['mp4', 'webm', 'mov'].includes(extension)) return 'video';
    if (['mp3', 'wav', 'ogg', 'm4a'].includes(extension)) return 'audio';
    return 'image';
}

function slugify(value) {
    const slug = String(value || 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, MAX_MODEL_SLUG_LENGTH);
    return slug || 'unknown';
}

function localTimestamp(date) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: OUTPUT_TIME_ZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        })
            .formatToParts(date)
            .map((part) => [part.type, part.value])
    );
    const millis = String(date.getMilliseconds()).padStart(3, '0');
    return {
        day: `${parts.year}-${parts.month}-${parts.day}`,
        stamp: `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}${millis}`,
    };
}

function sizeGuard(limit) {
    let total = 0;
    return new Transform({
        transform(chunk, _encoding, callback) {
            total += chunk.length;
            if (total > limit) callback(new OutputError('output_too_large', 413));
            else callback(null, chunk);
        },
    });
}

async function downloadTo(url, targetBase) {
    const response = await fetchAllowed(url);
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new OutputError(`upstream_status_${response.status}`, 502);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_OUTPUT_BYTES) {
        await response.body.cancel();
        throw new OutputError('output_too_large', 413);
    }
    const extension = resolveExtension(response.headers.get('content-type'), url);
    const finalPath = `${targetBase}.${extension}`;
    const partialPath = `${finalPath}.part`;
    try {
        await pipeline(
            Readable.fromWeb(response.body),
            sizeGuard(MAX_OUTPUT_BYTES),
            createWriteStream(partialPath, { flags: 'wx' })
        );
        await rename(partialPath, finalPath);
    } catch (error) {
        await unlink(partialPath).catch(() => {});
        throw error;
    }
    return { path: finalPath, extension, contentType: response.headers.get('content-type') };
}

function normalizeRequest(body) {
    const urls = Array.isArray(body?.urls) ? body.urls : body?.url ? [body.url] : [];
    if (urls.length === 0 || urls.length > MAX_URLS_PER_REQUEST) {
        throw new OutputError('invalid_urls', 400);
    }
    return {
        urls: urls.map(validateOutputUrl),
        model: typeof body.model === 'string' ? body.model : null,
        prompt: typeof body.prompt === 'string' ? body.prompt : null,
        requestId: typeof body.requestId === 'string' ? body.requestId : null,
        input: body.input && typeof body.input === 'object' ? body.input : null,
    };
}

// Saves every result to <output>/<YYYY-MM-DD>/<timestamp>-<model>[-n].<ext> with a .json sidecar.
export async function archiveOutputs(body) {
    const request = normalizeRequest(body);
    const now = new Date();
    const { day, stamp } = localTimestamp(now);
    const outputDir = getOutputDir();
    const dayDir = path.join(outputDir, day);
    await mkdir(dayDir, { recursive: true });
    const baseName = `${stamp}-${slugify(request.model)}`;

    const saved = [];
    for (const [index, url] of request.urls.entries()) {
        const suffix = request.urls.length > 1 ? `-${index + 1}` : '';
        const targetBase = path.join(dayDir, `${baseName}${suffix}`);
        const file = await downloadTo(url, targetBase);
        const sidecar = {
            savedAt: now.toISOString(),
            type: mediaKind(file.extension),
            contentType: file.contentType,
            model: request.model,
            prompt: request.prompt,
            requestId: request.requestId,
            sourceUrl: url.href,
            file: path.basename(file.path),
            input: request.input,
        };
        await writeFile(`${targetBase}.json`, `${JSON.stringify(sidecar, null, 2)}\n`, { flag: 'wx' });
        saved.push(path.relative(outputDir, file.path));
    }
    return saved;
}
