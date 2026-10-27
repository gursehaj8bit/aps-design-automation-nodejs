// Makes a TEST SVF bundle for one family's .rfa and stores it where the platform's family viewer
// reads it. Run through npm, which loads .env when it exists:
//
//   npm run family:svf -- --sha256 <rfa sha256> [--env local] [--region US] [--out <dir>] [--dry-run]
//
// 1. Reads <env>/families/<sha256> from the platform's Azure container and checks its sha256.
// 2. Uploads it to a transient OSS bucket as <sha256>.rfa (the suffix picks the Revit translator).
// 3. Translates it to SVF (version 1), 3D views only, and waits for the manifest.
// 4. Downloads every file the Viewer needs (each 3D .svf and its assets, the property database,
//    the AEC model data) through the signedcookies endpoint, keeping each path under output/.
// 5. Writes bubble.json (the manifest with $file$/ URNs) and, unless --dry-run, uploads every file
//    to <env>/families/<sha256>.svf/<encoded path> (lib/svf-bundle.js; the platform's rule).
//
// This calls REAL Autodesk and Azure services. Azure is reached with the platform's own service
// principal through @azure/identity's ClientSecretCredential, from the five STORE_VARIABLES in this
// app's .env. Nothing secret is printed: every secret value is registered with a redactor as it
// appears (lib/redact.js).
// Exit codes: 0 done, 1 failed, 2 refused before anything was sent.

const _crypto = require('crypto');
const _fs = require('fs');
const _path = require('path');
const { parseArgs } = require('util');
const svf = require('../lib/svf-bundle');
const { createRedactor } = require('../lib/redact');

const APS = 'https://developer.api.autodesk.com';
const REGIONS = ['US', 'EMEA', 'AUS', 'CAN', 'DEU', 'IND', 'JPN', 'GBR'];
// Create Bucket needs bucket:create; the signed S3 upload data:create and data:write; the job
// data:create, data:write and data:read; the manifest and signedcookies data:read.
const SCOPES = ['bucket:create', 'data:read', 'data:write', 'data:create'];
const DOWNLOAD_CONCURRENCY = 6;
// The platform's store and the service principal it writes with (platform/backend/.env names).
const STORE_VARIABLES = [
    'PRODUCT_STORE_AZURE_ACCOUNT_URL',
    'PRODUCT_STORE_AZURE_CONTAINER',
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET'
];

const USAGE = `Usage:
  npm run family:svf -- --sha256 <rfa sha256> [--env local] [--region US] [--out <dir>] [--dry-run]
                        [--timeout-minutes 30]

Makes a test SVF bundle for the family RFA stored at <env>/families/<sha256> in the platform's
Azure container, and uploads it to <env>/families/<sha256>.svf/. Calls real Autodesk and Azure.
  --env              the platform's environment folder (default: local)
  --region           Model Derivative and OSS region: ${REGIONS.join(', ')} (default: US)
  --out <dir>        also write the bundle to <dir>, laid out by its paths
  --dry-run          do everything except the upload to Azure
  --source <file>    translate this local file (a .rvt holding the family) instead of the RFA,
                     which Model Derivative does not read; stored under --sha256 all the same
  --timeout-minutes  how long to wait for the translation (default: 30)
Settings, from this app's .env:
  APS_CLIENT_ID, APS_CLIENT_SECRET
  ${STORE_VARIABLES.join(', ')}`;

const secrets = createRedactor();
const scrub = secrets.redact;

function out(line) {
    console.log(scrub(line));
}

function sleep(ms) {
    return (new Promise((resolve) => setTimeout(resolve, ms)));
}

function need(names) {
    for (const name of names) {
        if (!(process.env[name] || '').trim())
            throw new svf.Refusal(`${name} is not set. Put it in this app's .env (see .env.example) or export it.`);
    }
}

// ---------------------------------------------------------------------------------------------
// HTTP. Every Autodesk call goes through call(); a signed URL is never printed, only `what`.

/// fetch with retries on 429 and 5xx. req: { method, url, headers, body, okStatuses, what, show }.
/// `show` is the URL to name in an error (default: the URL without its query); pass a plain label
/// for a signed URL.
async function call(req) {
    const show = req.show || (req.method + ' ' + req.url.split('?')[0]);
    for (let attempt = 1; ; attempt++) {
        let res;
        try {
            res = await fetch(req.url, {
                method: req.method,
                headers: req.headers || {},
                body: req.body,
                signal: AbortSignal.timeout(req.timeoutMs || 5 * 60 * 1000)
            });
        } catch (ex) {
            if (attempt < 4) {
                await sleep(2000 * attempt);
                continue;
            }
            throw new Error(`${req.what} failed: ${show}: ${scrub(ex.message)}`);
        }
        if (res.ok || (req.okStatuses || []).includes(res.status))
            return (res);
        if ((res.status === 429 || res.status >= 500) && attempt < 4) {
            const after = parseInt(res.headers.get('retry-after'), 10);
            await res.arrayBuffer().catch(() => null);
            await sleep(Number.isFinite(after) ? after * 1000 : 2000 * attempt);
            continue;
        }
        const text = await res.text().catch(() => '');
        throw new Error(`${req.what} failed: ${show} answered ${res.status}: ${scrub(text.substring(0, 500))}`);
    }
}

async function json(res) {
    const text = await res.text();
    return (text ? JSON.parse(text) : null);
}

/// A two-legged token (client credentials), POST /authentication/v2/token.
async function getToken() {
    const basic = secrets.add(Buffer.from(`${process.env.APS_CLIENT_ID.trim()}:${secrets.add(process.env.APS_CLIENT_SECRET.trim())}`).toString('base64'));
    const res = await call({
        method: 'POST', url: APS + '/authentication/v2/token', what: 'Get an APS token',
        headers: { 'Authorization': 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPES.join(' ') }).toString()
    });
    const data = await json(res);
    if (!data || typeof data.access_token !== 'string')
        throw new Error('Get an APS token failed: the answer held no access_token');
    return (secrets.add(data.access_token));
}

// ---------------------------------------------------------------------------------------------
// Azure: the platform's container, with the platform's service principal.

/// The container client. Refuses, naming the first missing variable, before anything is sent.
function container() {
    need(STORE_VARIABLES);
    const env = (name) => process.env[name].trim();
    const { ClientSecretCredential } = require('@azure/identity');
    const { BlobServiceClient } = require('@azure/storage-blob');
    const credential = new ClientSecretCredential(env('AZURE_TENANT_ID'), env('AZURE_CLIENT_ID'), secrets.add(env('AZURE_CLIENT_SECRET')));
    const accountUrl = env('PRODUCT_STORE_AZURE_ACCOUNT_URL').replace(/\/+$/, '');
    return ({
        client: new BlobServiceClient(accountUrl, credential).getContainerClient(env('PRODUCT_STORE_AZURE_CONTAINER')),
        where: `${accountUrl}/${env('PRODUCT_STORE_AZURE_CONTAINER')}`
    });
}

/// Azure SDK errors can carry request details; only the status and code are passed on, or the
/// sign-in failure when that is what failed.
async function azure(what, fn) {
    try {
        return (await fn());
    } catch (ex) {
        if (ex && (ex.name === 'AuthenticationError' || ex.name === 'CredentialUnavailableError'))
            throw new Error(`${what} failed: Azure sign-in failed: ${scrub(ex.message)}`);
        const status = ex && (ex.statusCode || ex.status);
        const code = ex && (ex.code || (ex.details && ex.details.errorCode));
        throw new Error(`${what} failed: Azure answered ${status || 'no status'}${code ? ' (' + code + ')' : ''}`);
    }
}

// ---------------------------------------------------------------------------------------------
// Autodesk: OSS upload, the translation, the manifest and the downloads.

/// POST /oss/v2/buckets, transient. 409 means it exists already (ours, or another app's: then the
/// upload is refused with a 403).
async function ensureBucket(token, bucketKey, region) {
    const res = await call({
        method: 'POST', url: APS + '/oss/v2/buckets', what: 'Create the OSS bucket', okStatuses: [409],
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'x-ads-region': region },
        body: JSON.stringify({ bucketKey: bucketKey, policyKey: 'transient' })
    });
    await res.arrayBuffer();
    return (res.status === 409 ? 'exists' : 'created');
}

/// The signed S3 upload: GET signeds3upload, PUT the bytes to the one URL, POST the uploadKey.
/// Answers the OSS object id.
async function uploadObject(token, bucketKey, objectKey, bytes) {
    const path = `${APS}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}/signeds3upload`;
    const auth = { 'Authorization': 'Bearer ' + token };
    const signed = await json(await call({
        method: 'GET', url: path + '?parts=1&minutesExpiration=10', what: 'Get a signed S3 upload URL', headers: auth
    }));
    if (!signed || typeof signed.uploadKey !== 'string' || !Array.isArray(signed.urls) || signed.urls.length !== 1)
        throw new Error('Get a signed S3 upload URL failed: the answer held no uploadKey and single URL');
    secrets.add(signed.urls[0]);
    secrets.add(signed.uploadKey);
    const put = await call({
        method: 'PUT', url: signed.urls[0], what: 'Upload the RFA', show: 'PUT <signed S3 upload URL>',
        headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, timeoutMs: 30 * 60 * 1000
    });
    await put.arrayBuffer();
    const done = await json(await call({
        method: 'POST', url: path, what: 'Complete the S3 upload',
        headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
        body: JSON.stringify({ uploadKey: signed.uploadKey })
    }));
    if (!done || typeof done.objectId !== 'string')
        throw new Error('Complete the S3 upload failed: the answer held no objectId');
    return (done.objectId);
}

/// POST /modelderivative/v2/designdata/job: SVF (version 1), 3D views, replacing any earlier manifest.
async function startJob(token, urn, region) {
    const res = await call({
        method: 'POST', url: APS + '/modelderivative/v2/designdata/job', what: 'Start the translation',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'x-ads-force': 'true', 'region': region },
        body: JSON.stringify({ input: { urn: urn }, output: { formats: [{ type: 'svf', views: ['3d'] }] } })
    });
    await res.arrayBuffer();
    return (res.status);
}

function messagesOf(manifest) {
    const lines = [];
    const walk = (n) => {
        if (n === null || typeof n !== 'object')
            return;
        for (const m of n.messages || [])
            lines.push(`${m.type || 'message'} ${m.code || ''}: ${Array.isArray(m.message) ? m.message.join(' ') : m.message}`.trim());
        for (const c of n.derivatives || n.children || [])
            walk(c);
    };
    walk(manifest);
    return (lines);
}

/// GET .../manifest until the translation ends, backing off from 5 s to 30 s.
async function waitForManifest(tokenFor, urn, region, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let delay = 5000;
    let last = '';
    while (true) {
        const res = await call({
            method: 'GET', url: `${APS}/modelderivative/v2/designdata/${urn}/manifest`, what: 'Read the manifest',
            headers: { 'Authorization': 'Bearer ' + await tokenFor(), 'region': region }, okStatuses: [202, 404]
        });
        const manifest = res.status === 200 ? await json(res) : (await res.arrayBuffer(), null);
        const status = manifest ? manifest.status : 'pending';
        const progress = manifest ? `${status} ${manifest.progress || ''}`.trim() : 'not there yet';
        if (progress !== last)
            out(`  translation: ${progress}`);
        last = progress;
        if (status === 'success')
            return (manifest);
        if (status === 'failed' || status === 'timeout') {
            const why = messagesOf(manifest);
            throw new Error(`the translation ended "${status}"` + (why.length ? ':\n  ' + why.join('\n  ') : ''));
        }
        if (Date.now() + delay > deadline)
            throw new Error(`the translation did not finish within ${Math.round(timeoutMs / 60000)} minutes (last: ${progress})`);
        await sleep(delay);
        delay = Math.min(Math.round(delay * 1.5), 30000);
    }
}

/// GET .../manifest/{derivativeUrn}/signedcookies, then GET its URL with its three cookies.
/// Answers the bytes, or null when `optional` and Autodesk has no such file.
async function downloadDerivative(tokenFor, urn, derivativeUrn, region, rel, optional) {
    const res = await call({
        method: 'GET',
        url: `${APS}/modelderivative/v2/designdata/${urn}/manifest/${encodeURIComponent(derivativeUrn)}/signedcookies`,
        what: 'Get a download for ' + rel, show: 'GET .../signedcookies for ' + rel,
        headers: { 'Authorization': 'Bearer ' + await tokenFor(), 'region': region },
        okStatuses: optional ? [404] : []
    });
    if (res.status === 404) {
        await res.arrayBuffer();
        return (null);
    }
    const pairs = res.headers.getSetCookie().map((c) => c.split(';')[0].trim()).filter(Boolean);
    for (const p of pairs)
        secrets.add(p.substring(p.indexOf('=') + 1));
    const cookie = secrets.add(pairs.join('; '));
    const info = await json(res);
    if (!info || typeof info.url !== 'string')
        throw new Error(`Get a download for ${rel} failed: the answer held no url`);
    secrets.add(info.url);
    const file = await call({
        method: 'GET', url: info.url, what: 'Download ' + rel, show: 'GET <signed download URL> for ' + rel,
        headers: { 'Cookie': cookie }, okStatuses: optional ? [403, 404] : []
    });
    if (!file.ok) {
        await file.arrayBuffer();
        return (null);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (typeof info.size === 'number' && info.size !== bytes.length)
        out(`  note: ${rel} is ${bytes.length} bytes, Autodesk said ${info.size} (the download may have been decompressed)`);
    return (bytes);
}

async function pool(items, size, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            await fn(items[i]);
        }
    });
    await Promise.all(workers);
}

// ---------------------------------------------------------------------------------------------

async function main(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            'sha256': { type: 'string' },
            'env': { type: 'string', default: 'local' },
            'region': { type: 'string', default: 'US' },
            'out': { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            'source': { type: 'string' },
            'timeout-minutes': { type: 'string', default: '30' },
            'help': { type: 'boolean', short: 'h', default: false }
        },
        strict: true
    });
    if (values.help) {
        out(USAGE);
        return (0);
    }
    if (!values.sha256)
        throw Object.assign(new svf.Refusal('--sha256 <rfa sha256> is required'), { showUsage: true });
    const sha = values.sha256.trim().toLowerCase();
    const env = values.env;
    const rfaKey = svf.rfaKey(env, sha);
    const region = values.region.toUpperCase();
    if (!REGIONS.includes(region))
        throw new svf.Refusal(`--region must be one of ${REGIONS.join(', ')}`);
    const timeoutMinutes = Number(values['timeout-minutes']);
    if (!(timeoutMinutes > 0))
        throw new svf.Refusal('--timeout-minutes must be a positive number');
    need(['APS_CLIENT_ID', 'APS_CLIENT_SECRET']);
    const { client: store, where } = container();
    const bucketKey = svf.bucketKeyFor(process.env.APS_CLIENT_ID.trim(), region);

    // 1. The file to translate: the RFA from the platform's container, or --source. Model
    // Derivative takes no .rfa (GET /designdata/formats lists rvt, not rfa, and a renamed RFA is
    // refused as Revit-UnsupportedFileType_rfa), so --source names a project file (.rvt) holding
    // the family; the bundle is still stored under the RFA's fingerprint.
    out(`store:   ${where}`);
    let rfa;
    let suffix = '.rfa';
    if (values.source) {
        suffix = _path.extname(values.source).toLowerCase();
        if (!/^\.[a-z0-9]+$/.test(suffix))
            throw new svf.Refusal('--source must name a file with an extension Model Derivative reads, such as .rvt');
        rfa = _fs.readFileSync(values.source);
        out(`source:  ${values.source}, ${rfa.length} bytes, stored under ${sha}`);
    } else {
        out(`rfa:     ${rfaKey}`);
        rfa = await azure('Read the RFA from Azure', () => store.getBlobClient(rfaKey).downloadToBuffer());
        const got = _crypto.createHash('sha256').update(rfa).digest('hex');
        if (got !== sha)
            throw new Error(`the blob at ${rfaKey} has sha256 ${got}, not ${sha}`);
        out(`         ${rfa.length} bytes, sha256 checked`);
    }

    // 2-3. Token, bucket, upload.
    let token = await getToken();
    let tokenAt = Date.now();
    // Two-legged tokens last an hour; take a new one well before that.
    const tokenFor = async () => {
        if (Date.now() - tokenAt > 40 * 60 * 1000) {
            token = await getToken();
            tokenAt = Date.now();
        }
        return (token);
    };
    out(`bucket:  ${bucketKey} (${await ensureBucket(token, bucketKey, region)}, transient, ${region})`);
    const objectId = await uploadObject(await tokenFor(), bucketKey, sha + suffix, rfa);
    const urn = svf.urnOf(objectId);
    out(`object:  ${objectId}`);

    // 4-5. Translate and wait.
    out(`job:     svf, 3d (HTTP ${await startJob(await tokenFor(), urn, region)})`);
    const manifest = await waitForManifest(tokenFor, urn, region, timeoutMinutes * 60 * 1000);
    const plan = svf.planFromManifest(manifest);
    if (plan.svfs.length === 0) {
        const why = messagesOf(manifest);
        throw new Error('the manifest has no 3D svf viewable' + (why.length ? ':\n  ' + why.join('\n  ') : ''));
    }

    // 6. Download. Each file is kept by its path under output/.
    const files = new Map();
    const fetchOne = async (sibling, rel, optional) => {
        svf.refusePath(rel);
        if (rel === svf.BUBBLE)
            throw new svf.Refusal('Model Derivative wrote a file named bubble.json at the root of output/');
        if (files.has(rel))
            return;
        files.set(rel, null);
        const bytes = await downloadDerivative(tokenFor, urn, svf.derivativeUrnFor(sibling, rel), region, rel, optional);
        if (bytes === null)
            files.delete(rel);
        else
            files.set(rel, bytes);
    };
    for (const s of plan.svfs) {
        await fetchOne(s.urn, s.rel, false);
        const assets = svf.svfAssetRels(s.rel, svf.readSvfManifest(files.get(s.rel)));
        out(`svf:     ${s.rel} (${assets.length} assets)`);
        await pool(assets, DOWNLOAD_CONCURRENCY, (rel) => fetchOne(s.urn, rel, false));
    }
    if (plan.propertyDb) {
        const rels = [plan.propertyDb.rel].concat(svf.propertyDbRels(plan.propertyDb.rel));
        await pool(rels, DOWNLOAD_CONCURRENCY, (rel) => fetchOne(plan.propertyDb.urn, rel, rel !== plan.propertyDb.rel));
        out(`props:   ${rels.filter((r) => files.has(r)).length} of ${rels.length} property database files`);
    } else {
        out('props:   the manifest has no property database');
    }
    if (plan.aecModelData) {
        await fetchOne(plan.aecModelData.urn, plan.aecModelData.rel, false);
        out(`aec:     ${plan.aecModelData.rel}`);
    } else {
        out('aec:     the manifest has no AEC model data');
    }

    // 7. bubble.json.
    files.set(svf.BUBBLE, Buffer.from(JSON.stringify(svf.rewriteManifest(manifest)), 'utf8'));

    // 8. Store.
    const rels = Array.from(files.keys()).sort();
    const keys = rels.map((rel) => [rel, svf.keyFor(env, sha, rel)]);
    if (values.out) {
        const root = _path.resolve(values.out);
        for (const rel of rels) {
            const dest = _path.join(root, ...rel.split('/'));
            _fs.mkdirSync(_path.dirname(dest), { recursive: true });
            _fs.writeFileSync(dest, files.get(rel));
        }
        out(`local:   ${root}`);
    }
    if (!values['dry-run']) {
        await pool(keys, DOWNLOAD_CONCURRENCY, ([rel, key]) => azure('Upload ' + rel, () =>
            store.getBlockBlobClient(key).uploadData(files.get(rel), {
                blobHTTPHeaders: { blobContentType: svf.contentTypeFor(rel) }
            })));
    }

    // 9. Summary.
    const total = rels.reduce((n, rel) => n + files.get(rel).length, 0);
    out('');
    out(`${rels.length} files, ${total} bytes ${values['dry-run'] ? 'NOT uploaded (--dry-run); would go' : 'uploaded'} to ${svf.bundlePrefix(env, sha)}`);
    out(`The platform serves it at /api/families/<id>/versions/<seq>/viewable/bubble.json for the version whose file sha256 is ${sha}.`);
    return (0);
}

main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((ex) => {
        const badArgs = ex && typeof ex.code === 'string' && ex.code.startsWith('ERR_PARSE_ARGS');
        const refused = badArgs || ex instanceof svf.Refusal;
        console.error((refused ? 'Refused: ' : 'Failed: ') + scrub(ex && ex.message));
        if (badArgs || (ex && ex.showUsage))
            console.error(USAGE);
        process.exit(refused ? 2 : 1);
    });
