// lib/redact.js: the family-svf script hides secrets by value, never by shape, so plain paths
// named by a UUID or a sha256 print as they are.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRedactor, MASK } = require('../lib/redact');

const SECRET = 'cs~S3cr3t.Value_with/odd+chars=';

test.describe('redaction by value', () => {
    test.it('hides registered values and their URI-encoded form', () => {
        const r = createRedactor();
        r.add(SECRET);
        r.add('eyJ0eXAiOiJKV1QiLCJhbGciOi.token');
        const text = `secret=${SECRET} enc=${encodeURIComponent(SECRET)} Bearer eyJ0eXAiOiJKV1QiLCJhbGciOi.token`;
        assert.equal(r.redact(text), `secret=${MASK} enc=${MASK} Bearer ${MASK}`);
    });

    test.it('hides a whole signed URL, the longer secret first', () => {
        const r = createRedactor();
        const url = 'https://cdn.example/a/b.pf?Policy=abcdefgh&Signature=ijklmnop';
        r.add('Signature=ijklmnop');
        r.add(url);
        assert.equal(r.redact('GET ' + url + ' failed'), `GET ${MASK} failed`);
    });

    test.it('leaves plain paths alone: UUID and sha256 folder names, query-like text, Bearer labels', () => {
        const r = createRedactor();
        r.add(SECRET);
        const plain = [
            '/private/tmp/claude-502/x/589c29f0-e4fa-4349-8492-f81fbaea8c4a/scratchpad/svf-out',
            `local/families/${'ab'.repeat(32)}.svf/Resource/3D_20View/_7b3D_7d/_7b3D_7d.svf`,
            'https://acct.blob.core.windows.net/platform',
            'sv=2022 sig=x se=y license=MIT Bearer <none> Basic auth',
            'https://example.com/a?b=c'
        ];
        for (const p of plain)
            assert.equal(r.redact(p), p);
    });

    test.it('ignores short and non-string values', () => {
        const r = createRedactor();
        r.add('abc');
        r.add(undefined);
        r.add(12345678);
        assert.equal(r.redact('abc 12345678 undefined'), 'abc 12345678 undefined');
    });
});
