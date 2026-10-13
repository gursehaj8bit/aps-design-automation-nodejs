// Reads an add-in's AppBundle zip and checks it before it is uploaded to Autodesk.
//
// Ported from the parent repo's revit/tools/da/lib/zip.ts (the reader, the forbidden entries and
// the forbidden strings unchanged). Uploading a bundle sends compiled code out of the building, so
// the zip that is about to leave is checked here as well as by build-bundle.ps1, whatever built it.
// The reader handles stored and deflated entries and refuses zip64, which a bundle never needs.
//
// THE FORBIDDEN STRINGS are four client and project names, in the same order as build.ps1's list,
// compared case-sensitively as UTF-8 and as UTF-16LE (.NET keeps string literals in UTF-16). They
// are written as character codes so this source never carries them as text; a hit is reported by
// its position in the list, never by its text.

const { inflateRawSync } = require('zlib');

function u16(b, at) {
    return (b[at] | (b[at + 1] << 8));
}

function u32(b, at) {
    return ((b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0);
}

/// The entries in the zip's central directory: { name, method, compressedSize, size, offset }.
function listZipEntries(zip) {
    // The end-of-central-directory record sits in the last 22 + 65,535 bytes (its comment's maximum).
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
        if (u32(zip, i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        throw new Error('not a zip file: no end-of-central-directory record');
    const count = u16(zip, eocd + 10);
    const cdOffset = u32(zip, eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff)
        throw new Error('zip64 archives are not supported');

    const entries = [];
    let at = cdOffset;
    for (let n = 0; n < count; n++) {
        if (at + 46 > zip.length || u32(zip, at) !== 0x02014b50)
            throw new Error('the zip\'s central directory is damaged');
        const flags = u16(zip, at + 8);
        const nameLen = u16(zip, at + 28);
        const extraLen = u16(zip, at + 30);
        const commentLen = u16(zip, at + 32);
        // Bit 11 marks a UTF-8 name. Without it the name is code page 437, which agrees with UTF-8
        // for every character a bundle path uses.
        const name = new TextDecoder((flags & 0x800) ? 'utf-8' : 'latin1').decode(zip.subarray(at + 46, at + 46 + nameLen));
        entries.push({
            name: name,
            method: u16(zip, at + 10),
            compressedSize: u32(zip, at + 20),
            size: u32(zip, at + 24),
            offset: u32(zip, at + 42)
        });
        at += 46 + nameLen + extraLen + commentLen;
    }
    return (entries);
}

/// One entry's uncompressed bytes.
function readZipEntry(zip, entry) {
    const at = entry.offset;
    if (u32(zip, at) !== 0x04034b50)
        throw new Error(entry.name + ': bad local header');
    const start = at + 30 + u16(zip, at + 26) + u16(zip, at + 28);
    const data = zip.subarray(start, start + entry.compressedSize);
    if (entry.method === 0)
        return (data);
    if (entry.method === 8)
        return (new Uint8Array(inflateRawSync(data)));
    throw new Error(entry.name + ': compression method ' + entry.method + ' is not supported');
}

/// The forbidden strings, #1 to #4: build.ps1's list, in build.ps1's order.
const FORBIDDEN_STRINGS = Object.freeze([
    [72, 89, 68, 49, 52, 49],
    [78, 86, 53],
    [66, 79, 77, 49, 52, 51],
    [67, 116, 114, 108, 83]
].map((codes) => String.fromCharCode.apply(null, codes)));

function containsBytes(hay, needle) {
    return (Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).indexOf(needle) !== -1);
}

/// Each needle found in `bytes` (by 0-based index) and in which encoding, UTF-8 before UTF-16LE.
function findStringHits(bytes, needles) {
    const hits = [];
    needles.forEach((n, index) => {
        if (containsBytes(bytes, Buffer.from(n, 'utf8')))
            hits.push({ index: index, encoding: 'UTF-8' });
        if (containsBytes(bytes, Buffer.from(n, 'utf16le')))
            hits.push({ index: index, encoding: 'UTF-16LE' });
    });
    return (hits);
}

/// Why an entry may never ship in any add-in's bundle, or null when it may.
function forbiddenEntry(name) {
    const base = name.split('/').pop() || name;
    if (/^RevitAPI/i.test(base))
        return ('Revit\'s own API assemblies (RevitAPI, RevitAPIUI) are supplied by the engine, and RevitAPIUI does not exist there');
    if (/^(AdWindows|UIFramework[A-Za-z]*)\.dll$/i.test(base))
        return ('a Revit user-interface assembly; no add-in has a user interface');
    if (/^RevitJobs\.Contracts\.dll$/i.test(base))
        return ('a RevitServer assembly; nothing in the cloud host uses it');
    if (/\.rvt$/i.test(base))
        return ('a model never ships in a bundle; it is an input');
    return (null);
}

/// Checks one add-in's bundle zip: forward slashes; exactly one top-level <addin>.bundle folder
/// holding PackageContents.xml and Contents/<addin>.addin; no forbidden entries; none of the
/// forbidden strings in any entry. Returns { entries, problems }.
function checkBundleZip(zip, addin, forbiddenStrings) {
    forbiddenStrings = forbiddenStrings || FORBIDDEN_STRINGS;
    const problems = [];
    let entries;
    try {
        entries = listZipEntries(zip);
    } catch (ex) {
        return ({ entries: [], problems: [ex.message] });
    }
    const roots = new Set();
    for (const e of entries) {
        if (e.name.includes('\\'))
            problems.push(e.name + ': uses a backslash; zip paths must use \'/\' or Revit will not find the files');
        roots.add(e.name.split('/')[0]);
        const why = forbiddenEntry(e.name);
        if (why !== null)
            problems.push(e.name + ': forbidden (' + why + ')');
    }
    const root = addin + '.bundle';
    if (roots.size !== 1 || !roots.has(root))
        problems.push('the zip must hold exactly one top-level folder, ' + root + ', and nothing else; it holds ' + Array.from(roots).join(', '));
    if (!entries.some((e) => e.name === root + '/PackageContents.xml'))
        problems.push(root + '/PackageContents.xml is missing');
    if (!entries.some((e) => e.name === root + '/Contents/' + addin + '.addin'))
        problems.push(root + '/Contents/' + addin + '.addin is missing');
    for (const e of entries) {
        if (e.name.endsWith('/'))
            continue;
        let bytes;
        try {
            bytes = readZipEntry(zip, e);
        } catch (ex) {
            problems.push(ex.message);
            continue;
        }
        for (const h of findStringHits(bytes, forbiddenStrings))
            problems.push(e.name + ': contains forbidden string #' + (h.index + 1) + ' (' + h.encoding + ')');
    }
    return ({ entries: entries, problems: problems });
}

module.exports = {
    FORBIDDEN_STRINGS,
    checkBundleZip,
    listZipEntries,
    readZipEntry
};
