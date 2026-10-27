// lib/svf-bundle.js: the storage key rule the platform shares (the family viewer contract,
// section 1), the refused paths, the bubble.json rewrite, the download plan and the ZIP reader
// that opens an .svf. No test reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const svf = require('../lib/svf-bundle');

const SHA = 'ab'.repeat(32);
const B64 = 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6Yi9hLnJmYQ';
const D = (rel) => `urn:adsk.viewing:fs.file:${B64}/output/${rel}`;

/// A ZIP of [name, text, deflate?] entries, deflated ones through deflateRawSync.
function makeZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, text, deflate] of files) {
        const nameBytes = Buffer.from(name, 'utf8');
        const raw = Buffer.from(text, 'utf8');
        const data = deflate ? zlib.deflateRawSync(raw) : raw;
        const method = deflate ? 8 : 0;
        const crc = zlib.crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(raw.length, 24);
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

test.describe('enc() and the key', () => {
    test.it('follows the contract\'s examples', () => {
        assert.equal(svf.encodeSegment('3D View'), '3D_20View');
        assert.equal(svf.encodeSegment('{3D}.svf'), '_7b3D_7d.svf');
        assert.equal(svf.encodeSegment('objects_attrs.json.gz'), 'objects_5fattrs.json.gz');
        assert.equal(svf.encodeSegment('.hidden'), '_2ehidden');
        assert.equal(svf.encodeSegment('..x.'), '_2e.x.');
        assert.equal(svf.encodeSegment('a@b+c'), 'a_40b_2bc');
        assert.equal(svf.encodeSegment('Az09-.'), 'Az09-.');
        assert.equal(svf.encodeSegment('bubble.json'), 'bubble.json');
    });

    test.it('encodes UTF-8 bytes with lowercase hex, inside the platform\'s key grammar', () => {
        assert.equal(svf.encodeSegment('é'), '_c3_a9');
        assert.equal(svf.encodeSegment('ÿ中'), '_c3_bf_e4_b8_ad');
        for (const s of ['{3D}', '_', ' x', '.a', 'ä€', '~!$&\'()*,;=:'])
            assert.match(svf.encodeSegment(s), /^[A-Za-z0-9._@+-]+$/);
    });

    test.it('builds the key under <env>/families/<sha>.svf/, one encoded segment per path segment', () => {
        assert.equal(svf.keyFor('local', SHA, 'bubble.json'), `local/families/${SHA}.svf/bubble.json`);
        assert.equal(svf.keyFor('local', SHA, 'Resource/3D View/{3D}/{3D}.svf'),
            `local/families/${SHA}.svf/Resource/3D_20View/_7b3D_7d/_7b3D_7d.svf`);
        assert.equal(svf.keyFor('local', SHA, 'Resource/objects_attrs.json.gz'),
            `local/families/${SHA}.svf/Resource/objects_5fattrs.json.gz`);
        assert.equal(svf.rfaKey('local', SHA), `local/families/${SHA}`);
        assert.equal(svf.bundlePrefix('local', SHA), `local/families/${SHA}.svf/`);
    });

    test.it('refuses a bad sha256 or environment', () => {
        assert.throws(() => svf.keyFor('local', SHA.toUpperCase(), 'a'), { name: 'Refusal' });
        assert.throws(() => svf.keyFor('local', 'abc', 'a'), { name: 'Refusal' });
        assert.throws(() => svf.keyFor('../x', SHA, 'a'), { name: 'Refusal' });
        assert.throws(() => svf.keyFor('', SHA, 'a'), { name: 'Refusal' });
    });
});

test.describe('refused paths', () => {
    const refused = {
        'empty': '',
        'leading slash': '/Resource/a.pf',
        'backslash': 'Resource\\a.pf',
        'hash': 'Resource/a#b.pf',
        'question mark': 'Resource/a?b.pf',
        'percent': 'Resource/a%20b.pf',
        'empty segment': 'Resource//a.pf',
        'trailing slash': 'Resource/',
        'dot segment': 'Resource/./a.pf',
        'dot-dot segment': 'Resource/../a.pf',
        'only dot-dot': '..'
    };
    for (const [name, path] of Object.entries(refused)) {
        test.it('refuses ' + name, () => {
            assert.notEqual(svf.whyRefused(path), null);
            assert.throws(() => svf.refusePath(path), { name: 'Refusal' });
            assert.throws(() => svf.keyFor('local', SHA, path), { name: 'Refusal' });
        });
    }

    test.it('refuses a non-string', () => {
        assert.throws(() => svf.refusePath(undefined), { name: 'Refusal' });
    });

    test.it('accepts spaces, braces, dots inside a name and a leading-dot name', () => {
        for (const p of ['Resource/3D View/{3D}/{3D}.svf', 'a', '.hidden/x', 'a..b/c'])
            assert.equal(svf.refusePath(p), p);
    });
});

const MANIFEST = {
    type: 'manifest',
    status: 'success',
    progress: 'complete',
    urn: B64,
    derivatives: [{
        name: 'family.rfa',
        outputType: 'svf',
        status: 'success',
        children: [
            { urn: D('Resource/model.sdb'), role: 'Autodesk.CloudPlatform.PropertyDatabase', mime: 'application/autodesk-db', type: 'resource' },
            { urn: D('Resource/AECModelData.json'), role: 'Autodesk.AEC.ModelData', mime: 'application/json', type: 'resource' },
            {
                type: 'geometry', role: '3d', name: '{3D}', guid: 'g3',
                children: [
                    { urn: D('Resource/3D View/{3D}/{3D}.svf'), role: 'graphics', mime: 'application/autodesk-svf', type: 'resource' },
                    { urn: D('Resource/3D View/{3D}/{3D}1.png'), role: 'thumbnail', mime: 'image/png', type: 'resource', resolution: [100, 100] }
                ]
            },
            {
                type: 'geometry', role: '2d', name: 'Sheet',
                children: [{ urn: D('Resource/Sheet/a.svf'), role: 'graphics', mime: 'application/autodesk-svf', type: 'resource' }]
            }
        ]
    }, {
        outputType: 'svf2',
        children: [{ type: 'geometry', role: '3d', children: [{ urn: D('svf2/x.svf'), mime: 'application/autodesk-svf' }] }]
    }, {
        outputType: 'thumbnail',
        children: [{ urn: `urn:adsk.viewing:fs.file:${B64}/output/preview1.png`, role: 'thumbnail' }]
    }]
};

test.describe('bubble.json', () => {
    test.it('rewrites every derivative URN to $file$/<path under output/> and leaves the rest alone', () => {
        const bubble = svf.rewriteManifest(MANIFEST);
        assert.equal(bubble.urn, B64, 'the source URN is not a derivative URN');
        assert.equal(bubble.status, 'success');
        const kids = bubble.derivatives[0].children;
        assert.equal(kids[0].urn, '$file$/Resource/model.sdb');
        assert.equal(kids[2].children[0].urn, '$file$/Resource/3D View/{3D}/{3D}.svf', 'not percent-encoded');
        assert.equal(kids[2].guid, 'g3');
        assert.deepEqual(kids[2].children[1].resolution, [100, 100]);
        assert.equal(bubble.derivatives[2].children[0].urn, '$file$/preview1.png');
        assert.ok(!JSON.stringify(bubble).includes('urn:adsk.viewing'));
    });

    test.it('accepts JSON text and does not change its input', () => {
        const before = JSON.stringify(MANIFEST);
        assert.deepEqual(svf.rewriteManifest(before), svf.rewriteManifest(MANIFEST));
        assert.equal(JSON.stringify(MANIFEST), before);
    });

    test.it('leaves a URN with no /output/ and other urn: strings alone', () => {
        const m = { a: 'urn:adsk.objects:os.object:b/a.rfa', b: 'urn:adsk.viewing:fs.file:abc/other/x', c: 1, d: null, e: true };
        assert.deepEqual(svf.rewriteManifest(m), m);
    });
});

test.describe('the download plan', () => {
    test.it('takes the 3D svf of the svf derivative, the property database and the AEC model data', () => {
        const plan = svf.planFromManifest(MANIFEST);
        assert.deepEqual(plan.svfs, [{ urn: D('Resource/3D View/{3D}/{3D}.svf'), rel: 'Resource/3D View/{3D}/{3D}.svf' }]);
        assert.deepEqual(plan.propertyDb, { urn: D('Resource/model.sdb'), rel: 'Resource/model.sdb' });
        assert.deepEqual(plan.aecModelData, { urn: D('Resource/AECModelData.json'), rel: 'Resource/AECModelData.json' });
        assert.deepEqual(svf.planFromManifest({ derivatives: [] }), { svfs: [], propertyDb: null, aecModelData: null });
    });

    test.it('resolves svf assets against the .svf folder, skips embed:/ and refuses an escape', () => {
        const rel = 'Resource/3D View/{3D}/{3D}.svf';
        const assets = [
            { id: 'a', URI: '0.pf' }, { id: 'b', URI: 'embed:/Camera.bin' },
            { id: 'c', URI: '../../objects_attrs.json.gz' }, { id: 'd', URI: 'Materials.json.gz' }, { id: 'e' }
        ];
        assert.deepEqual(svf.svfAssetRels(rel, { assets: assets }), [
            'Resource/3D View/{3D}/0.pf', 'Resource/objects_attrs.json.gz', 'Resource/3D View/{3D}/Materials.json.gz'
        ]);
        assert.throws(() => svf.svfAssetRels(rel, { assets: [{ URI: '../../../../x' }] }), { name: 'Refusal' });
        assert.throws(() => svf.svfAssetRels(rel, { assets: [{ URI: 'a%20b.pf' }] }), { name: 'Refusal' });
    });

    test.it('lists the property database files beside the db node', () => {
        assert.deepEqual(svf.propertyDbRels('Resource/model.sdb'), svf.PROPERTY_DB_FILES.map((f) => 'Resource/' + f));
        assert.deepEqual(svf.propertyDbRels('model.sdb'), svf.PROPERTY_DB_FILES);
        assert.equal(svf.derivativeUrnFor(D('Resource/model.sdb'), 'Resource/objects_ids.json.gz'), D('Resource/objects_ids.json.gz'));
    });

    test.it('names the bucket from the client id within the OSS rule, and base64url-encodes the object id', () => {
        assert.equal(svf.bucketKeyFor('AbC123xyz', 'US'), 'abc123xyz_family_svf_us');
        assert.match(svf.bucketKeyFor('A'.repeat(32), 'EMEA'), /^[-_.a-z0-9]{3,128}$/);
        assert.throws(() => svf.bucketKeyFor('', 'US'), { name: 'Refusal' });
        assert.equal(svf.urnOf('urn:adsk.objects:os.object:b/a.rfa'), 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6Yi9hLnJmYQ');
        assert.equal(svf.contentTypeFor('bubble.json'), 'application/json');
        assert.equal(svf.contentTypeFor('Resource/Materials.json.gz'), 'application/octet-stream');
    });
});

test.describe('the ZIP reader', () => {
    const inner = JSON.stringify({ name: 'LMV Manifest', assets: [{ id: 'g', URI: '0.pf' }] });

    test.it('reads a deflated manifest.json out of an .svf', () => {
        const zip = makeZip([['metadata.json', '{"x":1}', true], ['manifest.json', inner, true]]);
        assert.deepEqual(svf.readSvfManifest(zip), JSON.parse(inner));
        assert.equal(Buffer.from(svf.readZipFile(zip, 'metadata.json')).toString(), '{"x":1}');
        assert.equal(svf.readZipFile(zip, 'nope.json'), null);
    });

    test.it('reads a stored entry, and fails clearly without manifest.json or on a non-zip', () => {
        assert.deepEqual(svf.readSvfManifest(makeZip([['manifest.json', inner, false]])), JSON.parse(inner));
        assert.throws(() => svf.readSvfManifest(makeZip([['metadata.json', '{}', false]])), /no manifest\.json/);
        assert.throws(() => svf.readSvfManifest(new Uint8Array(40)), /not a zip file/);
    });
});
