const _path = require('path');
const _fs = require('fs');
const express = require('express');
const multer = require('multer');
const {
    ContainerClient,
    StorageSharedKeyCredential,
    BlobSASPermissions,
    generateBlobSASQueryParameters
} = require('@azure/storage-blob');

const UPLOAD_DIR = _path.join(__dirname, '..', 'uploads');
const MAX_SAS_MINUTES = 7 * 24 * 60;

let router = express.Router();

function settings() {
    return {
        account: process.env.AZURE_STORAGE_ACCOUNT_NAME,
        container: process.env.AZURE_STORAGE_CONTAINER_NAME,
        // Accept the token with or without the leading '?' the portal copies it with.
        sasToken: (process.env.AZURE_STORAGE_SAS_TOKEN || '').replace(/^\?/, ''),
        // Optional: only needed to mint short-lived, read-only links (see /blob/sas).
        accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY
    };
}

// Resolved per request so a missing variable is a clear 500 rather than a crash at startup,
// which would also take the Design Automation page down with it.
function containerClient() {
    const s = settings();
    const missing = [
        ['AZURE_STORAGE_ACCOUNT_NAME', s.account],
        ['AZURE_STORAGE_CONTAINER_NAME', s.container],
        ['AZURE_STORAGE_SAS_TOKEN', s.sasToken]
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length)
        throw Object.assign(new Error(`Missing environment variables: ${missing.join(', ')}`), { status: 500 });
    return new ContainerClient(`https://${s.account}.blob.core.windows.net/${s.container}?${s.sasToken}`);
}

// Blob names can contain '/', so they travel as a query parameter rather than a path segment.
function blobName(req) {
    const name = (req.query.name || req.body && req.body.name || '').trim();
    if (!name)
        throw Object.assign(new Error('Query parameter "name" is required'), { status: 400 });
    return name;
}

function contentDisposition(type, name) {
    const base = _path.posix.basename(name);
    const ascii = base.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

function fail(res, err) {
    const status = err.status || err.statusCode || 500;
    console.error(`[blob] ${status}: ${err.message}`);
    res.status(status).json({ error: err.message });
}

router.get('/blob/config', (req, res) => {
    const s = settings();
    res.json({
        account: s.account || null,
        container: s.container || null,
        sasTokenSet: !!s.sasToken,
        canMintScopedSas: !!(s.account && s.accountKey)
    });
});

router.get('/blob/files', async (req, res) => {
    try {
        const files = [];
        for await (const blob of containerClient().listBlobsFlat({ prefix: req.query.prefix || undefined })) {
            files.push({
                name: blob.name,
                size: blob.properties.contentLength,
                contentType: blob.properties.contentType,
                lastModified: blob.properties.lastModified
            });
        }
        res.json(files);
    } catch (err) {
        fail(res, err);
    }
});

router.post('/blob/files', multer({ dest: UPLOAD_DIR }).array('files'), async (req, res) => {
    const files = req.files || [];
    try {
        if (!files.length)
            return res.status(400).json({ error: 'No files received (form field "files")' });
        const client = containerClient();
        const prefix = (req.body.prefix || '').trim().replace(/^\/+|\/+$/g, '');
        const rename = (req.body.name || '').trim().replace(/^\/+|\/+$/g, '');
        if (rename && files.length > 1)
            return res.status(400).json({ error: 'A file name can only be set when uploading a single file' });
        const uploaded = [];
        for (const f of files) {
            const base = rename || f.originalname;
            const name = prefix ? `${prefix}/${base}` : base;
            await client.getBlockBlobClient(name).uploadFile(f.path, {
                blobHTTPHeaders: { blobContentType: f.mimetype || 'application/octet-stream' }
            });
            uploaded.push({ name, size: f.size });
        }
        res.json({ uploaded });
    } catch (err) {
        fail(res, err);
    } finally {
        files.forEach(f => _fs.unlink(f.path, () => { }));
    }
});

async function streamBlob(req, res, disposition) {
    try {
        const name = blobName(req);
        const download = await containerClient().getBlobClient(name).download();
        res.setHeader('Content-Type', download.contentType || 'application/octet-stream');
        if (download.contentLength !== undefined)
            res.setHeader('Content-Length', download.contentLength);
        res.setHeader('Content-Disposition', contentDisposition(disposition, name));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // An uploaded HTML or SVG file viewed inline would otherwise run script on this origin.
        // PDF is exempt because Chrome refuses to open its PDF viewer inside a sandbox.
        if (disposition === 'inline' && download.contentType !== 'application/pdf')
            res.setHeader('Content-Security-Policy', 'sandbox');
        download.readableStreamBody.on('error', err => res.destroy(err)).pipe(res);
    } catch (err) {
        fail(res, err);
    }
}

router.get('/blob/download', (req, res) => streamBlob(req, res, 'attachment'));
router.get('/blob/view', (req, res) => streamBlob(req, res, 'inline'));

router.delete('/blob/files', async (req, res) => {
    try {
        const name = blobName(req);
        const result = await containerClient().getBlobClient(name).deleteIfExists({ deleteSnapshots: 'include' });
        if (!result.succeeded)
            return res.status(404).json({ error: `Blob not found: ${name}` });
        res.json({ deleted: name });
    } catch (err) {
        fail(res, err);
    }
});

// A SAS can only be signed with the account key. Without one, the link is the blob URL plus the
// configured token, which carries every permission and the expiry that token was issued with.
router.post('/blob/sas', async (req, res) => {
    try {
        const name = blobName(req);
        const blob = containerClient().getBlobClient(name);
        const s = settings();
        const plainUrl = blob.url.split('?')[0];

        if (s.accountKey) {
            const minutes = Math.min(Math.max(parseInt(req.body.expiresInMinutes, 10) || 60, 1), MAX_SAS_MINUTES);
            const expiresOn = new Date(Date.now() + minutes * 60 * 1000);
            const sas = generateBlobSASQueryParameters({
                containerName: s.container,
                blobName: name,
                permissions: BlobSASPermissions.parse('r'),
                startsOn: new Date(Date.now() - 5 * 60 * 1000), // tolerate clock skew
                expiresOn
            }, new StorageSharedKeyCredential(s.account, s.accountKey)).toString();
            return res.json({ url: `${plainUrl}?${sas}`, scoped: true, permissions: 'r', expiresOn });
        }

        const params = new URLSearchParams(s.sasToken);
        res.json({
            url: `${plainUrl}?${s.sasToken}`,
            scoped: false,
            permissions: params.get('sp'),
            expiresOn: params.get('se')
        });
    } catch (err) {
        fail(res, err);
    }
});

module.exports = router;
