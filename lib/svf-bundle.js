// The pure half of scripts/family-svf.js: how a family's SVF bundle is named in the platform's
// object store, which paths are refused, how the Model Derivative manifest becomes bubble.json,
// and which files a Viewer needs. No network, no file system.
//
// THE KEY CONVENTION IS SHARED WITH THE PLATFORM. The parent repo's backend builds and reads the
// same keys in Python (the family viewer contract, section 1). encodeSegment, refusePath and keyFor
// must stay byte-for-byte equal to that rule; change neither side alone.
//
//   <env>/families/<rfa sha256>.svf/<enc(seg1)>/…/<enc(segN)>
//
// The bundle sits beside the RFA's own key, <env>/families/<rfa sha256>, rather than under it: on
// the platform's local-disk store that key is a file, so a folder of the same name would collide.

const _posix = require('path').posix;
const { listZipEntries, readZipEntry } = require('./bundle-zip');

/// The prefix a derivative URN carries before its path under output/.
const DERIVATIVE_URN = /^urn:adsk\.viewing:fs\.file:[^/]+\/output\/(.+)$/;

const SHA256 = /^[0-9a-f]{64}$/;
const ENV = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/// The bubble.json at the bundle root: the manifest the Viewer loads first.
const BUBBLE = 'bubble.json';

/// Where the Viewer looks for the property database: beside the application/autodesk-db node.
const PROPERTY_DB_FILES = Object.freeze([
    'objects_attrs.json.gz',
    'objects_vals.json.gz',
    'objects_avs.json.gz',
    'objects_offs.json.gz',
    'objects_ids.json.gz'
]);

/// A request refused before anything was sent or written.
class Refusal extends Error {
    constructor(message) {
        super(message);
        this.name = 'Refusal';
    }
}

function isKeptByte(b, first) {
    return ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) ||
        b === 0x2d || (b === 0x2e && !first));
}

/// enc(segment): its UTF-8 bytes, keeping A-Z a-z 0-9 - and '.' (except as the first byte); every
/// other byte becomes '_' and two lowercase hex digits. Reversible, and inside the platform's key
/// grammar ^[A-Za-z0-9._@+-]+$.
function encodeSegment(segment) {
    const bytes = Buffer.from(String(segment), 'utf8');
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        out += isKeptByte(b, i === 0) ? String.fromCharCode(b) : '_' + b.toString(16).padStart(2, '0');
    }
    return (out);
}

/// Why a bundle-relative path is refused, or null when it is accepted.
function whyRefused(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0)
        return ('it is empty');
    if (relPath.startsWith('/'))
        return ('it starts with /');
    for (const c of ['\\', '#', '?', '%']) {
        if (relPath.includes(c))
            return ('it contains ' + c);
    }
    for (const seg of relPath.split('/')) {
        if (seg === '' || seg === '.' || seg === '..')
            return ('it has an empty, "." or ".." segment');
    }
    return (null);
}

/// Throws a Refusal when the path is refused; answers the path otherwise.
function refusePath(relPath) {
    const why = whyRefused(relPath);
    if (why !== null)
        throw new Refusal(`the bundle path ${JSON.stringify(relPath)} is refused: ${why}`);
    return (relPath);
}

function checkSha(rfaSha256) {
    if (typeof rfaSha256 !== 'string' || !SHA256.test(rfaSha256))
        throw new Refusal('the RFA sha256 must be 64 lowercase hex digits');
    return (rfaSha256);
}

function checkEnv(env) {
    if (typeof env !== 'string' || !ENV.test(env))
        throw new Refusal('the environment folder must be letters, digits, "." and "-" (got ' + JSON.stringify(env) + ')');
    return (env);
}

/// The RFA's own key: <env>/families/<sha256>.
function rfaKey(env, rfaSha256) {
    return (`${checkEnv(env)}/families/${checkSha(rfaSha256)}`);
}

/// The bundle's prefix, with its trailing slash: <env>/families/<sha256>.svf/
function bundlePrefix(env, rfaSha256) {
    return (rfaKey(env, rfaSha256) + '.svf/');
}

/// The object store key of one bundle file.
function keyFor(env, rfaSha256, relPath) {
    refusePath(relPath);
    return (bundlePrefix(env, rfaSha256) + relPath.split('/').map(encodeSegment).join('/'));
}

/// The path after /output/ of a derivative URN, or null when it is not one.
function outputRel(urn) {
    const m = typeof urn === 'string' ? DERIVATIVE_URN.exec(urn) : null;
    return (m ? m[1] : null);
}

/// The derivative URN of a path under the same output/ as `siblingUrn`.
function derivativeUrnFor(siblingUrn, relPath) {
    const at = siblingUrn.indexOf('/output/');
    if (outputRel(siblingUrn) === null || at < 0)
        throw new Error('not a derivative URN');
    return (siblingUrn.substring(0, at + '/output/'.length) + relPath);
}

/// bubble.json: a deep copy of the manifest with every derivative URN
/// urn:adsk.viewing:fs.file:<b64>/output/<rel> turned into $file$/<rel>. Nothing else changes; the
/// paths stay as Model Derivative wrote them, not percent-encoded. Takes an object or JSON text.
function rewriteManifest(manifestJson) {
    const manifest = typeof manifestJson === 'string' ? JSON.parse(manifestJson) : manifestJson;
    const walk = (v) => {
        if (Array.isArray(v))
            return (v.map(walk));
        if (v !== null && typeof v === 'object') {
            const out = {};
            for (const k of Object.keys(v))
                out[k] = walk(v[k]);
            return (out);
        }
        if (typeof v === 'string') {
            const rel = outputRel(v);
            return (rel === null ? v : '$file$/' + rel);
        }
        return (v);
    };
    return (walk(manifest));
}

/// What a Viewer needs from a finished manifest, as derivative nodes { urn, rel }:
/// { svfs: every application/autodesk-svf under a 3D geometry node of an "svf" derivative,
///   propertyDb: the application/autodesk-db node or null, aecModelData: the AEC model data or null }.
function planFromManifest(manifest) {
    const plan = { svfs: [], propertyDb: null, aecModelData: null };
    const node = (n) => ({ urn: n.urn, rel: outputRel(n.urn) });
    const walk = (n, role) => {
        if (n === null || typeof n !== 'object')
            return;
        if (n.type === 'geometry' && (n.role === '3d' || n.role === '2d'))
            role = n.role;
        if (outputRel(n.urn) !== null) {
            if (n.mime === 'application/autodesk-svf' && role === '3d')
                plan.svfs.push(node(n));
            else if (n.mime === 'application/autodesk-db' && plan.propertyDb === null)
                plan.propertyDb = node(n);
            else if (n.role === 'Autodesk.AEC.ModelData' && plan.aecModelData === null)
                plan.aecModelData = node(n);
        }
        for (const c of n.children || [])
            walk(c, role);
    };
    for (const d of (manifest && manifest.derivatives) || []) {
        // An svf2 derivative cannot be downloaded; only SVF (version 1) can.
        if (d.outputType === 'svf')
            walk(d, null);
    }
    return (plan);
}

/// The bundle-relative paths of the assets an .svf's own manifest.json lists, resolved against
/// the .svf's folder. embed:/ assets live inside the .svf and are skipped. An asset that would
/// leave output/ is refused.
function svfAssetRels(svfRel, svfManifest) {
    const dir = _posix.dirname(svfRel);
    const rels = [];
    for (const a of (svfManifest && svfManifest.assets) || []) {
        const uri = a && a.URI;
        if (typeof uri !== 'string' || uri === '' || uri.startsWith('embed:/'))
            continue;
        const rel = _posix.normalize(_posix.join(dir, uri));
        if (rel === '..' || rel.startsWith('../') || _posix.isAbsolute(rel))
            throw new Refusal(`${svfRel} lists the asset ${JSON.stringify(uri)}, which lies outside output/`);
        rels.push(refusePath(rel));
    }
    return (rels);
}

/// The paths of the property database files beside the application/autodesk-db node.
function propertyDbRels(dbRel) {
    const dir = _posix.dirname(dbRel);
    return (PROPERTY_DB_FILES.map((f) => (dir === '.' ? f : dir + '/' + f)));
}

/// One file's uncompressed bytes from a ZIP, by its exact name, or null when it is not there.
/// Stored and deflated entries (inflateRawSync), no zip64: an .svf needs nothing more.
function readZipFile(zip, name) {
    const entry = listZipEntries(zip).find((e) => e.name === name);
    return (entry ? readZipEntry(zip, entry) : null);
}

/// The manifest.json inside an .svf (an .svf is a ZIP).
function readSvfManifest(svfBytes) {
    const bytes = readZipFile(svfBytes, 'manifest.json');
    if (bytes === null)
        throw new Error('the .svf holds no manifest.json');
    return (JSON.parse(Buffer.from(bytes).toString('utf8')));
}

/// The OSS bucket this script keeps its RFAs in: from the client id, per region, inside OSS's
/// bucket key rule ^[-_.a-z0-9]{3,128}$ (lowercase letters, digits and underscores here).
function bucketKeyFor(clientId, region) {
    const id = String(clientId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!id)
        throw new Refusal('APS_CLIENT_ID gives no letters or digits to name a bucket with');
    const key = `${id}_family_svf_${String(region).toLowerCase()}`;
    if (!/^[-_.a-z0-9]{3,128}$/.test(key))
        throw new Refusal('the bucket key built from APS_CLIENT_ID breaks the OSS bucket key rule');
    return (key);
}

/// The URL-safe Base64 (no padding) of an OSS object id: the urn Model Derivative takes.
function urnOf(objectId) {
    return (Buffer.from(objectId, 'utf8').toString('base64url'));
}

/// The Content-Type a bundle file is stored with.
function contentTypeFor(relPath) {
    return (relPath.endsWith('.json') ? 'application/json' : 'application/octet-stream');
}

module.exports = {
    BUBBLE,
    PROPERTY_DB_FILES,
    Refusal,
    bucketKeyFor,
    bundlePrefix,
    contentTypeFor,
    derivativeUrnFor,
    encodeSegment,
    keyFor,
    outputRel,
    planFromManifest,
    propertyDbRels,
    readSvfManifest,
    readZipFile,
    refusePath,
    rewriteManifest,
    rfaKey,
    svfAssetRels,
    urnOf,
    whyRefused
};
