import { NextResponse } from 'next/server';
import { archiveOutputs, OutputError } from '../../../src/lib/outputStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

// Copies finished generation results (MuAPI CDN URLs) into the output/ folder of the project.
export async function POST(request) {
    // JSON only: a cross-site form or text/plain POST (no CORS preflight) is refused.
    if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
        return NextResponse.json({ error: 'unsupported_content_type' }, { status: 415 });
    }
    let body;
    try {
        const text = await request.text();
        if (text.length > MAX_REQUEST_BYTES) {
            return NextResponse.json({ error: 'request_too_large' }, { status: 413 });
        }
        body = JSON.parse(text);
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }

    try {
        const saved = await archiveOutputs(body);
        return NextResponse.json({ saved }, { status: 201 });
    } catch (error) {
        if (error instanceof OutputError) {
            console.warn(`[outputs] rejected: ${error.message}`);
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error('[outputs] archive failed:', error);
        return NextResponse.json({ error: 'archive_failed' }, { status: 500 });
    }
}
