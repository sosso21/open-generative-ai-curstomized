import { NextResponse } from 'next/server';

const MUAPI_BASE = 'https://api.muapi.ai';

function getApiKey(request) {
    const headerKey = request.headers.get('x-api-key');
    if (headerKey) return headerKey;
    // Cookie-based auth removed for security (CWE-522)
    return null;
}

async function toJsonResponse(response) {
    const text = await response.text();
    try {
        return NextResponse.json(JSON.parse(text), { status: response.status });
    } catch {
        // Non-JSON upstream errors (e.g. an HTML 413 page) keep their status and a readable detail.
        return NextResponse.json({ detail: text.slice(0, 500) || response.statusText }, { status: response.status });
    }
}

function cleanHeaders(request) {
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('connection');
    headers.delete('cookie');
    // Connection-level headers the streaming fetch refuses (curl sends Expect: 100-continue on large uploads).
    for (const name of ['expect', 'transfer-encoding', 'keep-alive', 'upgrade']) headers.delete(name);
    return headers;
}

// Proxies /api/api/v1/* -> https://api.muapi.ai/api/v1/*
// This is required because the AiAgent library hardcodes a double /api/api
export async function GET(request, { params }) {
    const slug = await params;
    const pathSegments = slug.path || [];
    const path = pathSegments.join('/');
    
    const { search } = new URL(request.url);
    const targetUrl = `${MUAPI_BASE}/api/v1/${path}${search}`;

    const headers = cleanHeaders(request);
    const apiKey = getApiKey(request);

    // NOTE: credential logging removed for security (CWE-200)
    if (apiKey) headers.set('x-api-key', apiKey);

    try {
        const response = await fetch(targetUrl, { headers, method: 'GET' });
        return await toJsonResponse(response);
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function POST(request, { params }) {
    const slug = await params;
    const pathSegments = slug.path || [];
    const path = pathSegments.join('/');
    
    const { search } = new URL(request.url);
    const targetUrl = `${MUAPI_BASE}/api/v1/${path}${search}`;

    const headers = cleanHeaders(request);
    const apiKey = getApiKey(request);
    if (apiKey) headers.set('x-api-key', apiKey);

    try {
        // Streamed, never buffered: uploads (POST upload_file) can be several gigabytes.
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: request.body,
            duplex: 'half',
        });
        return await toJsonResponse(response);
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
