// lib/publish.js through a recording http function: exactly which requests go out and with which
// bodies. Updates are a new version plus an alias move; nothing is ever deleted. No test reaches
// the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const _fs = require('fs');
const _os = require('os');
const _path = require('path');
const zlib = require('zlib');
const publish = require('../lib/publish');
const { checkBundleZip } = require('../lib/bundle-zip');

const DA = publish.DA_BASE;
const FIXTURES = _path.join(__dirname, 'fixtures', 'addins');

/// A recorder for http(req): answer(key, req) gives { status, data } for "METHOD path" (path under
/// DA_BASE, or the full URL for anything else). An unexpected request fails the test.
function recorder(answer) {
    const requests = [];
    const http = async (req) => {
        const key = req.method + ' ' + (req.url.startsWith(DA) ? req.url.substring(DA.length) : req.url);
        requests.push(Object.assign({ key: key }, req));
        const res = answer(key, req);
        if (res === undefined)
            throw new Error('unexpected request ' + key);
        return (res);
    };
    return ({ http: http, requests: requests, keys: () => requests.map((r) => r.key) });
}

/// A stored (uncompressed) zip of [name, text] pairs.
function makeZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, text] of files) {
        const nameBytes = Buffer.from(name, 'utf8');
        const data = Buffer.from(text, 'utf8');
        const crc = zlib.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x800, 6);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x800, 8);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBytes, data);
        centrals.push(central, nameBytes);
        offset += 30 + nameBytes.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return (new Uint8Array(Buffer.concat(locals.concat([cd, eocd]))));
}

const GOOD_BUNDLE = [
    ['HelloBundle.bundle/PackageContents.xml', '<ApplicationPackage/>'],
    ['HelloBundle.bundle/Contents/HelloBundle.addin', '<RevitAddIns/>'],
    ['HelloBundle.bundle/Contents/HelloBundle.dll', 'MZ']
];

/// A copy of the fixtures in a temp folder, so a test may add a dist/ zip.
function addinsCopy(zipFiles) {
    const root = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'addins-'));
    _fs.cpSync(FIXTURES, root, { recursive: true });
    if (zipFiles) {
        _fs.mkdirSync(_path.join(root, 'HelloBundle', 'dist'));
        _fs.writeFileSync(_path.join(root, 'HelloBundle', 'dist', 'HelloBundle.zip'), makeZip(zipFiles));
    }
    return (root);
}

function helloActivity(values) {
    const text = _fs.readFileSync(_path.join(FIXTURES, 'HelloBundle', 'activities', 'count_elements.json'), 'utf8');
    return (publish.fillActivity(text, values));
}

function noDelete(rec) {
    assert.ok(rec.requests.every((r) => r.method !== 'DELETE'), 'a DELETE was sent');
}

const UPLOAD = { endpointURL: 'https://s3.example/upload', formData: { key: 'k', policy: 'p' } };

test.describe('bundles', () => {
    test.it('the first publish creates the AppBundle, uploads the zip, then creates the alias', async () => {
        const root = addinsCopy(GOOD_BUNDLE);
        const rec = recorder((key) => {
            if (key === 'POST /appbundles') return ({ status: 200, data: { version: 1, uploadParameters: UPLOAD } });
            if (key === 'POST https://s3.example/upload') return ({ status: 204, data: null });
            if (key === 'POST /appbundles/HelloBundle/aliases') return ({ status: 200, data: {} });
        });
        const lines = [];
        const p = publish.createPublisher({ http: rec.http, addinsRoot: root, owner: 'acme', out: (l) => lines.push(l) });
        assert.equal(await p.publishBundle({ addin: 'HelloBundle', alias: 'dev' }), 0);
        assert.deepEqual(rec.keys(), ['POST /appbundles', 'POST https://s3.example/upload', 'POST /appbundles/HelloBundle/aliases']);
        assert.equal(rec.requests[0].json.id, 'HelloBundle');
        assert.equal(rec.requests[0].json.engine, 'Autodesk.Revit+2024');
        assert.match(rec.requests[0].json.description, /\(HelloBundle 1\.0\.0, sha256 [0-9a-f]{12}\)$/);
        const upload = rec.requests[1];
        assert.equal(upload.auth, false, 'the S3 upload must not carry the APS token');
        assert.deepEqual(upload.form.fields, UPLOAD.formData);
        assert.equal(upload.form.file.fileName, 'HelloBundle.zip');
        assert.deepEqual(rec.requests[2].json, { id: 'dev', version: 1 });
        assert.equal(lines[lines.length - 1], 'Created acme.HelloBundle version 1; alias dev created to it.');
        noDelete(rec);
    });

    test.it('a later publish posts a new version, uploads, and only then moves the alias', async () => {
        const root = addinsCopy(GOOD_BUNDLE);
        const rec = recorder((key) => {
            if (key === 'POST /appbundles') return ({ status: 409, data: null });
            if (key === 'POST /appbundles/HelloBundle/versions') return ({ status: 200, data: { version: 3, uploadParameters: UPLOAD } });
            if (key === 'POST https://s3.example/upload') return ({ status: 204, data: null });
            if (key === 'POST /appbundles/HelloBundle/aliases') return ({ status: 409, data: null });
            if (key === 'PATCH /appbundles/HelloBundle/aliases/uat') return ({ status: 200, data: {} });
        });
        const lines = [];
        const p = publish.createPublisher({ http: rec.http, addinsRoot: root, owner: 'acme', out: (l) => lines.push(l) });
        assert.equal(await p.publishBundle({ addin: 'HelloBundle', alias: 'uat' }), 0);
        assert.deepEqual(rec.keys(), [
            'POST /appbundles',
            'POST /appbundles/HelloBundle/versions',
            'POST https://s3.example/upload',
            'POST /appbundles/HelloBundle/aliases',
            'PATCH /appbundles/HelloBundle/aliases/uat'
        ]);
        assert.deepEqual(Object.keys(rec.requests[1].json), ['engine', 'description'], 'a new version names no id');
        assert.deepEqual(rec.requests[3].json, { id: 'uat', version: 3 });
        assert.deepEqual(rec.requests[4].json, { version: 3 });
        assert.equal(lines[lines.length - 1], 'Published acme.HelloBundle version 3; alias uat moved to it.');
        noDelete(rec);
    });

    test.it('a bad zip is refused before any request; --check-only sends nothing', async () => {
        const bad = addinsCopy(GOOD_BUNDLE.concat([['HelloBundle.bundle/Contents/RevitAPIUI.dll', 'MZ']]));
        const rec = recorder(() => undefined);
        const lines = [];
        const p = publish.createPublisher({ http: rec.http, addinsRoot: bad, owner: 'acme', out: (l) => lines.push(l) });
        await assert.rejects(p.publishBundle({ addin: 'HelloBundle', alias: 'dev' }), { name: 'Refusal', message: '1 problem(s) in the zip; nothing was uploaded' });
        assert.ok(lines.some((l) => l.startsWith('  problem: HelloBundle.bundle/Contents/RevitAPIUI.dll: forbidden')));

        const good = publish.createPublisher({ http: rec.http, addinsRoot: addinsCopy(GOOD_BUNDLE), out: () => {} });
        assert.equal(await good.publishBundle({ addin: 'HelloBundle', alias: 'dev', checkOnly: true }), 0);
        assert.deepEqual(rec.keys(), []);
    });

    test.it('a missing zip, a disabled add-in, an unknown add-in and a bad alias are refused', async () => {
        const rec = recorder(() => undefined);
        const p = publish.createPublisher({ http: rec.http, addinsRoot: addinsCopy(null), owner: 'acme', out: () => {} });
        await assert.rejects(p.publishBundle({ addin: 'HelloBundle', alias: 'dev' }), /dist\/HelloBundle\.zip does not exist\. Build it on Windows first: revit\/tools\/build-bundle\.ps1 -Addin HelloBundle/);
        await assert.rejects(p.publishBundle({ addin: 'OffAddin', alias: 'dev' }), /OffAddin is disabled/);
        await assert.rejects(p.publishActivity({ addin: 'OffAddin', alias: 'dev' }), /OffAddin is disabled/);
        await assert.rejects(p.publishActivity({ addin: 'Nope', alias: 'dev' }), /no add-in Nope .*found: HelloBundle, OffAddin/);
        await assert.rejects(p.publishActivity({ addin: 'HelloBundle', alias: 'staging' }), /the alias must be one of dev, uat, prod/);
        assert.deepEqual(rec.keys(), []);
    });

    test.it('the zip check wants exactly <Id>.bundle with PackageContents.xml and Contents/<Id>.addin', () => {
        assert.deepEqual(checkBundleZip(makeZip(GOOD_BUNDLE), 'HelloBundle').problems, []);
        assert.deepEqual(checkBundleZip(makeZip(GOOD_BUNDLE), 'OtherAddin').problems, [
            'the zip must hold exactly one top-level folder, OtherAddin.bundle, and nothing else; it holds HelloBundle.bundle',
            'OtherAddin.bundle/PackageContents.xml is missing',
            'OtherAddin.bundle/Contents/OtherAddin.addin is missing'
        ]);
        const hit = checkBundleZip(makeZip(GOOD_BUNDLE.concat([['HelloBundle.bundle/Contents/x.txt', 'abc ZZZ']])), 'HelloBundle', ['ZZZ']);
        assert.deepEqual(hit.problems, ['HelloBundle.bundle/Contents/x.txt: contains forbidden string #1 (UTF-8)']);
    });
});

test.describe('activities', () => {
    test.it('the first publish creates the activity, filled in, then creates the alias', async () => {
        const rec = recorder((key) => (key === 'POST /activities' ? { status: 200, data: { version: 1 } } : { status: 200, data: {} }));
        const lines = [];
        const p = publish.createPublisher({ http: rec.http, addinsRoot: FIXTURES, owner: 'acme', out: (l) => lines.push(l) });
        assert.equal(await p.publishActivity({ addin: 'HelloBundle', alias: 'dev' }), 0);
        assert.deepEqual(rec.keys(), ['POST /activities', 'POST /activities/HelloBundle_count_elements_v1/aliases']);
        assert.deepEqual(rec.requests[0].json, helloActivity({ owner: 'acme', bundleAlias: 'dev' }));
        assert.deepEqual(rec.requests[0].json.appbundles, ['acme.HelloBundle+dev']);
        assert.ok(!JSON.stringify(rec.requests[0].json).includes('{{'));
        assert.deepEqual(rec.requests[1].json, { id: 'dev', version: 1 });
        assert.equal(lines[0], 'Created acme.HelloBundle_count_elements_v1 version 1 (runs acme.HelloBundle+dev); alias dev created to it.');
        noDelete(rec);
    });

    test.it('a later publish posts a new version (no id in the body) and moves the existing alias', async () => {
        const rec = recorder((key) => {
            if (key === 'POST /activities') return ({ status: 409, data: null });
            if (key === 'POST /activities/HelloBundle_count_elements_v1/versions') return ({ status: 200, data: { version: 7 } });
            if (key === 'POST /activities/HelloBundle_count_elements_v1/aliases') return ({ status: 409, data: null });
            if (key === 'PATCH /activities/HelloBundle_count_elements_v1/aliases/uat') return ({ status: 200, data: {} });
        });
        const p = publish.createPublisher({ http: rec.http, addinsRoot: FIXTURES, owner: 'acme', out: () => {} });
        assert.equal(await p.publishActivity({ addin: 'HelloBundle', task: 'count_elements', alias: 'uat', bundleAlias: 'prod' }), 0);
        const expected = helloActivity({ owner: 'acme', bundleAlias: 'prod' });
        delete expected.id;
        assert.deepEqual(rec.requests[1].json, expected);
        assert.deepEqual(rec.requests[1].json.appbundles, ['acme.HelloBundle+prod']);
        assert.deepEqual(rec.requests[2].json, { id: 'uat', version: 7 });
        assert.deepEqual(rec.requests[3].json, { version: 7 });
        noDelete(rec);
    });

    test.it('--dry-run prints the filled activity and sends nothing; an unknown task is refused', async () => {
        const rec = recorder(() => undefined);
        const lines = [];
        const p = publish.createPublisher({ http: rec.http, addinsRoot: FIXTURES, owner: 'acme', out: (l) => lines.push(l) });
        assert.equal(await p.publishActivity({ addin: 'HelloBundle', alias: 'dev', dryRun: true }), 0);
        assert.deepEqual(JSON.parse(lines[0]), helloActivity({ owner: 'acme', bundleAlias: 'dev' }));
        await assert.rejects(p.publishActivity({ addin: 'HelloBundle', task: 'nope', alias: 'dev' }), /HelloBundle has no task nope \(has: count_elements\)/);
        assert.deepEqual(rec.keys(), []);
    });

    test.it('a missing rendered activity is refused, naming the render', async () => {
        const root = addinsCopy(null);
        _fs.rmSync(_path.join(root, 'HelloBundle', 'activities', 'count_elements.json'));
        const p = publish.createPublisher({ http: recorder(() => undefined).http, addinsRoot: root, owner: 'acme', out: () => {} });
        await assert.rejects(p.publishActivity({ addin: 'HelloBundle', alias: 'dev' }), /no rendered activity for its task count_elements .*Render the add-ins in the parent repo first/);
    });
});

test.describe('placeholders and owner', () => {
    test.it('{{owner}} and {{bundleAlias}} are both filled, everywhere', () => {
        const a = publish.fillActivity('{"x":"{{owner}}.B+{{bundleAlias}}","y":"{{owner}}"}', { owner: 'acme', bundleAlias: 'uat' });
        assert.deepEqual(a, { x: 'acme.B+uat', y: 'acme' });
    });

    test.it('a value outside the DA id alphabet, or a placeholder left over, is refused', () => {
        assert.throws(() => publish.fillActivity('{"a":"{{owner}}"}', { owner: 'x","y', bundleAlias: 'dev' }), /owner must be letters, digits and underscores only/);
        assert.throws(() => publish.fillActivity('{"a":"{{alias}}"}', { owner: 'acme', bundleAlias: 'dev' }), /still holds \{\{alias\}\}/);
    });

    test.it('the owner is APS_DA_NICKNAME when set, else what Design Automation calls this app', async () => {
        const rec = recorder((key) => (key === 'GET /forgeapps/me' ? { status: 200, data: 'acme_nick' } : undefined));
        assert.equal(await publish.resolveOwner(rec.http, { APS_DA_NICKNAME: 'set_nick' }), 'set_nick');
        assert.deepEqual(rec.keys(), []);
        assert.equal(await publish.resolveOwner(rec.http, {}), 'acme_nick');
        assert.deepEqual(rec.keys(), ['GET /forgeapps/me']);
    });
});

test.describe('check-remote', () => {
    test.it('reads each enabled activity at the alias and reports drift, a missing one, or none', async () => {
        const hello = helloActivity({ owner: 'acme', bundleAlias: 'dev' });
        // As DA might echo it: qualified id, a version, required:false omitted, zip/ondemand false added.
        const same = Object.assign(structuredClone(hello), { id: 'acme.HelloBundle_count_elements_v1+dev', version: 4 });
        delete same.parameters.outputModel.required;
        same.parameters.out_counts.zip = false;
        same.parameters.out_counts.ondemand = false;

        const ok = recorder((key) => (key === 'GET /activities/acme.HelloBundle_count_elements_v1+dev' ? { status: 200, data: same } : undefined));
        const okLines = [];
        const p = publish.createPublisher({ http: ok.http, addinsRoot: FIXTURES, owner: 'acme', out: (l) => okLines.push(l) });
        assert.equal(await p.checkRemote({ alias: 'dev' }), 0);
        // OffAddin is disabled, so it is never read.
        assert.deepEqual(ok.keys(), ['GET /activities/acme.HelloBundle_count_elements_v1+dev']);
        assert.deepEqual(okLines, ['ok     acme.HelloBundle_count_elements_v1+dev', 'check-remote: 1 activity at +dev, 0 drifted.']);

        const drifted = structuredClone(same);
        drifted.parameters.out_counts.localName = 'counts.json';
        drifted.parameters.out_counts.required = true;
        delete drifted.parameters.outputModel;
        drifted.parameters.extra = { verb: 'get' };
        drifted.appbundles = ['acme.HelloBundle+prod'];
        const bad = recorder(() => ({ status: 200, data: drifted }));
        const lines = [];
        const q = publish.createPublisher({ http: bad.http, addinsRoot: FIXTURES, owner: 'acme', out: (l) => lines.push(l) });
        assert.equal(await q.checkRemote({ alias: 'dev' }), 1);
        assert.deepEqual(lines, [
            'DRIFT  acme.HelloBundle_count_elements_v1+dev:',
            '         appbundles: published ["acme.HelloBundle+prod"], rendered ["acme.HelloBundle+dev"]',
            '         parameter out_counts.localName: published "counts.json", rendered "element-counts.json"',
            '         parameter out_counts.required: published true, rendered false',
            '         parameter outputModel: not published',
            '         parameter extra: published but not rendered',
            'check-remote: 1 activity at +dev, 1 drifted.'
        ]);

        const missing = recorder(() => ({ status: 404, data: null }));
        const mLines = [];
        const r = publish.createPublisher({ http: missing.http, addinsRoot: FIXTURES, owner: 'acme', out: (l) => mLines.push(l) });
        assert.equal(await r.checkRemote({ alias: 'uat' }), 1);
        assert.equal(mLines[0], 'DRIFT  acme.HelloBundle_count_elements_v1+uat: Design Automation does not know it (npm run publish:activity -- --addin HelloBundle --task count_elements --alias uat)');
        for (const rec of [ok, bad, missing])
            assert.ok(rec.requests.every((x) => x.method === 'GET'), 'check-remote must only read');
    });
});

test.describe('liveHttp', () => {
    test.it('sends the token to DA, never to the S3 upload, puts the file last, and honours okStatuses', async () => {
        const calls = [];
        const realFetch = global.fetch;
        global.fetch = async (url, init) => {
            calls.push({ url: url, init: init });
            return (new Response(url.endsWith('/activities') ? 'conflict' : '{"version":2}', { status: url.endsWith('/activities') ? 409 : 200 }));
        };
        try {
            const http = publish.liveHttp(async () => 'TOKEN');
            const conflict = await http({ method: 'POST', url: DA + '/activities', json: { id: 'A' }, okStatuses: [409], what: 'Create Activity' });
            assert.equal(conflict.status, 409);
            assert.equal(calls[0].init.headers.Authorization, 'Bearer TOKEN');
            assert.equal(calls[0].init.body, '{"id":"A"}');

            await http({ method: 'POST', url: 'https://s3.example/up', auth: false, form: { fields: { key: 'k', policy: 'p' }, file: { bytes: new Uint8Array([1, 2]), fileName: 'X.zip' } }, what: 'AppBundle upload' });
            assert.equal(calls[1].init.headers.Authorization, undefined);
            assert.deepEqual(Array.from(calls[1].init.body.keys()), ['key', 'policy', 'file']);

            await assert.rejects(http({ method: 'POST', url: DA + '/activities', json: {}, what: 'Create Activity' }), /Create Activity failed: POST .*\/activities answered 409: conflict/);
        } finally {
            global.fetch = realFetch;
        }
    });
});
