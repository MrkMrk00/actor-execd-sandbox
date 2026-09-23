// Keeps /workspace durable across Apify run restarts.
//
//   supervisor.mjs restore          restore the snapshot; runs before execd
//                                   starts so no request sees a half-restored
//                                   workspace
//   supervisor.mjs run -- <cmd...>  run the workload (Jupyter) and snapshot on
//                                   `migrating` / `aborting` events and SIGTERM
//
// execd (PID 1) forwards signals to the run mode and exits with its status.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, utimesSync, closeSync, openSync } from 'node:fs';
import { Readable } from 'node:stream';

const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace';
const MARKER = process.env.WORKSPACE_MARKER || '/tmp/workspace-snapshot.marker';
const STORE_NAME = process.env.WORKSPACE_KV_STORE || 'execd-sandbox-workspace';
const RECORD_KEY = process.env.WORKSPACE_KV_KEY || 'workspace.tar.gz';
const API_BASE = (process.env.APIFY_API_PUBLIC_BASE_URL || 'https://api.apify.com').replace(/\/$/, '');
const TOKEN = process.env.APIFY_TOKEN || '';
const EVENTS_URL = process.env.ACTOR_EVENTS_WEBSOCKET_URL || '';
const ENABLED = Boolean(TOKEN) && process.env.WORKSPACE_PERSIST !== '0';

const MODE = process.argv[2];
const childArgs = process.argv.slice(process.argv.indexOf('--') + 1);

if (MODE !== 'restore' && !(MODE === 'run' && childArgs.length > 0)) {
    throw new Error('usage: supervisor.mjs restore | supervisor.mjs run -- <command> [args...]');
}

function log(msg) {
    console.log(`[supervisor] ${msg}`);
}

function authHeaders(extra = {}) {
    return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

async function resolveStoreId() {
    const res = await fetch(`${API_BASE}/v2/key-value-stores?name=${encodeURIComponent(STORE_NAME)}`, {
        method: 'POST',
        headers: authHeaders(),
    });

    if (!res.ok) {
        throw new Error(`create/get key-value store "${STORE_NAME}" failed: ${res.status} ${await res.text()}`);
    }

    const body = await res.json();

    return body.data.id;
}

function touchMarker() {
    closeSync(openSync(MARKER, 'w'));
    const now = new Date();
    utimesSync(MARKER, now, now);
}

function runToCompletion(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], ...opts });
        proc.on('error', reject);
        proc.on('close', (code) => resolve({ code, proc }));
    });
}

function isDirty() {
    if (!existsSync(MARKER)) {
        return true;
    }

    const find = spawn('find', [WORKSPACE, '-newer', MARKER, '-print', '-quit'], { stdio: ['ignore', 'pipe', 'inherit'] });

    return new Promise((resolve) => {
        let out = '';
        find.stdout.on('data', (d) => { out += d; });
        find.on('close', () => resolve(out.trim().length > 0));
    });
}

async function restore(storeId) {
    const res = await fetch(`${API_BASE}/v2/key-value-stores/${storeId}/records/${encodeURIComponent(RECORD_KEY)}`, {
        headers: authHeaders(),
    });

    if (res.status === 404) {
        log(`no snapshot "${RECORD_KEY}" in store "${STORE_NAME}", starting with an empty workspace`);

        return;
    }

    if (!res.ok) {
        throw new Error(`download snapshot failed: ${res.status} ${await res.text()}`);
    }

    mkdirSync(WORKSPACE, { recursive: true });
    const tar = spawn('tar', ['-xzf', '-', '-C', WORKSPACE], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((resolve, reject) => {
        tar.on('error', reject);
        tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
    });
    await Readable.fromWeb(res.body).pipe(tar.stdin);
    await done;
    log(`restored workspace snapshot (${res.headers.get('content-length') || '?'} bytes)`);
}

let snapshotInFlight = null;

function snapshot(storeId, reason) {
    if (snapshotInFlight) {
        return snapshotInFlight;
    }

    snapshotInFlight = (async () => {
        if (!(await isDirty())) {
            log(`snapshot skipped (${reason}): workspace unchanged`);

            return;
        }

        const started = Date.now();
        const tar = spawn('tar', ['-C', WORKSPACE, '-czf', '-', '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
        const res = await fetch(`${API_BASE}/v2/key-value-stores/${storeId}/records/${encodeURIComponent(RECORD_KEY)}`, {
            method: 'PUT',
            headers: authHeaders({ 'Content-Type': 'application/gzip' }),
            body: Readable.toWeb(tar.stdout),
            duplex: 'half',
        });

        if (!res.ok) {
            throw new Error(`upload snapshot failed: ${res.status} ${await res.text()}`);
        }

        touchMarker();
        log(`snapshot uploaded (${reason}) in ${Date.now() - started}ms`);
    })().finally(() => {
        snapshotInFlight = null;
    });

    return snapshotInFlight;
}

function watchPlatformEvents(onEvent) {
    if (!EVENTS_URL) {
        return;
    }

    let ws;

    function connect() {
        ws = new WebSocket(EVENTS_URL);
        ws.addEventListener('message', (ev) => {
            let msg;

            try {
                msg = JSON.parse(String(ev.data));
            } catch {
                return;
            }

            onEvent(msg);
        });
        ws.addEventListener('close', () => setTimeout(connect, 5000).unref());
        ws.addEventListener('error', () => {});
    }

    connect();
}

async function main() {
    if (!ENABLED) {
        log('workspace persistence disabled (no APIFY_TOKEN or WORKSPACE_PERSIST=0)');
    }

    if (MODE === 'restore') {
        if (ENABLED) {
            await restore(await resolveStoreId());
            touchMarker();
        }

        return;
    }

    const storeId = ENABLED ? await resolveStoreId() : null;
    const child = spawn(childArgs[0], childArgs.slice(1), { stdio: 'inherit' });
    let shuttingDown = false;

    async function shutdown(signal) {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        log(`received ${signal}, snapshotting before stopping the workload`);

        if (storeId) {
            try {
                await snapshot(storeId, signal);
            } catch (err) {
                console.error('[supervisor] snapshot on shutdown failed:', err);
            }
        }

        child.kill('SIGTERM');
    }

    process.on('SIGTERM', () => { shutdown('SIGTERM'); });
    process.on('SIGINT', () => { shutdown('SIGINT'); });

    if (storeId) {
        watchPlatformEvents((msg) => {
            if (msg.name === 'migrating' || msg.name === 'aborting') {
                log(`platform event ${msg.name}: ${JSON.stringify(msg.data ?? {})}`);
                snapshot(storeId, msg.name).catch((err) => console.error('[supervisor] snapshot failed:', err));
            }
        });
    }

    // execd signals the whole process group, so the workload may die before
    // the shutdown snapshot finishes. Always snapshot before exiting.
    child.on('exit', async (code, signal) => {
        log(`workload exited (code=${code}, signal=${signal})`);

        if (storeId) {
            try {
                await snapshot(storeId, 'workload exit');
            } catch (err) {
                console.error('[supervisor] final snapshot failed:', err);
            }
        }

        const graceful = shuttingDown && signal === 'SIGTERM';
        process.exit(graceful ? 0 : (code ?? 1));
    });
}

main().catch((err) => {
    console.error('[supervisor] fatal:', err);
    process.exit(1);
});
