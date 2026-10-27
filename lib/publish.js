// Publishes the add-ins rendered in the parent repo's revit/addins/ to Design Automation, and
// compares what is published with what is rendered.
//
// Ported from the parent repo's revit/tools/da (lib/aps.ts and lib/commands.ts). The parent repo
// renders revit/addins/<Id>/activities/<task>.json from each addin.json; this module only reads
// those files and the built bundle zip, and never writes into the parent repo.
//
// Two rules hold throughout:
//
// UPDATES ARE NEW VERSIONS AND AN ALIAS MOVE. A published AppBundle or Activity is never deleted
// and re-created. The first publish creates it (POST /appbundles or /activities); every later one
// posts a new version (POST .../{id}/versions) and points the alias at it (POST .../aliases, or
// PATCH .../aliases/{alias} when it exists). A queued work item keeps the version it was submitted
// against, and the old version is still there to point back to. This module has no delete call.
//
// ALL HTTP GOES THROUGH ONE INJECTABLE FUNCTION, http(req) -> { status, data }. liveHttp() is the
// real one; the tests pass a recorder and check the exact request bodies.

const _fs = require('fs');
const _path = require('path');
const _crypto = require('crypto');
const { checkBundleZip } = require('./bundle-zip');

const DA_BASE = 'https://developer.api.autodesk.com/da/us-east/v3';

/// The aliases a deployment runs; the parent repo's revit/local-da/CONTRACT.md accepts exactly these.
const ALIASES = ['dev', 'uat', 'prod'];

/// Letters, digits and underscores: the alphabet of DA ids, aliases and nicknames.
const DA_ID = /^[A-Za-z0-9_]+$/;

/// The parent repo's revit/addins, as seen from this app's folder (revit/aps-design-automation-nodejs).
const DEFAULT_ADDINS_ROOT = _path.resolve(__dirname, '..', '..', 'addins');

/// A request refused before anything was sent: a bad argument, a missing file or setting.
class Refusal extends Error {
    constructor(message) {
        super(message);
        this.name = 'Refusal';
    }
}

/// ADDINS_ROOT when set (a relative path is taken from this app's folder), else ../addins.
function addinsRootFromEnv(env) {
    const raw = ((env || process.env).ADDINS_ROOT || '').trim();
    return (raw ? _path.resolve(__dirname, '..', raw) : DEFAULT_ADDINS_ROOT);
}

function assertDaId(what, v) {
    if (typeof v !== 'string' || !DA_ID.test(v))
        throw new Refusal(what + ' must be letters, digits and underscores only');
}

function checkAlias(alias) {
    if (!ALIASES.includes(alias))
        throw new Refusal('the alias must be one of ' + ALIASES.join(', ') + ' (got ' + JSON.stringify(alias) + ')');
    return (alias);
}

// ---------------------------------------------------------------------------------------------
// The live HTTP function.

/// The real http(req). getToken() answers a 2-legged access token with the code:all scope.
/// req: { method, url, json?, form?: { fields, file: { bytes, fileName } }, auth?: false,
///        okStatuses?: [409, ...], what, timeoutMs? }
/// A status outside 2xx and okStatuses throws, naming `what`, the status and DA's own answer.
function liveHttp(getToken) {
    return (async function http(req) {
        const headers = {};
        let body;
        // The S3 upload carries no Authorization header: the signed policy in the form is the credential.
        if (req.auth !== false)
            headers.Authorization = 'Bearer ' + await getToken();
        if (req.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(req.json);
        } else if (req.form) {
            body = new FormData();
            for (const k of Object.keys(req.form.fields || {}))
                body.append(k, String(req.form.fields[k]));
            // The file must be the last field: S3 ignores every field after it.
            body.append('file', new Blob([req.form.file.bytes], { type: 'application/octet-stream' }), req.form.file.fileName);
        }
        const response = await fetch(req.url, {
            method: req.method,
            headers: headers,
            body: body,
            signal: AbortSignal.timeout(req.timeoutMs || 120000)
        });
        const text = await response.text();
        if (!response.ok && !(req.okStatuses || []).includes(response.status)) {
            // The URL without its query string: a signed URL's query is a credential.
            throw new Error(`${req.what} failed: ${req.method} ${req.url.split('?')[0]} answered ${response.status}: ${text.substring(0, 500)}`);
        }
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (ex) {
            data = text;
        }
        return ({ status: response.status, data: data });
    });
}

/// A getToken() for liveHttp that reuses the app's cached, self-refreshing 2-legged client.
function appTokenGetter() {
    const { getClient } = require('../routes/common/oauth');
    return (async () => {
        const client = await getClient();
        if (!client)
            throw new Error('Could not get an APS token. Check APS_CLIENT_ID and APS_CLIENT_SECRET.');
        return (client.getCredentials().access_token);
    });
}

function da(path) {
    return (DA_BASE + path);
}

// ---------------------------------------------------------------------------------------------
// The Design Automation calls.

/// Points `alias` at `version`, creating the alias the first time. Answers 'created' or 'moved'.
async function setAlias(http, kind, id, alias, version) {
    assertDaId('an alias', alias);
    assertDaId('an id', id);
    const created = await http({
        method: 'POST', url: da(`/${kind}/${id}/aliases`), json: { id: alias, version: version },
        okStatuses: [409], what: 'Create alias'
    });
    if (created.status !== 409)
        return ('created');
    await http({
        method: 'PATCH', url: da(`/${kind}/${id}/aliases/${alias}`), json: { version: version },
        what: 'Move alias'
    });
    return ('moved');
}

function versionOf(res, what) {
    const version = res.data && res.data.version;
    if (typeof version !== 'number')
        throw new Error(what + ': Design Automation gave no version number in its answer');
    return (version);
}

/// Publishes the zip as a new version of the AppBundle (creating it the first time), uploads it,
/// and only then points the alias at it, so the alias never names a version with no code behind it.
async function publishAppBundleZip(http, opts) {
    assertDaId('an AppBundle id', opts.id);
    let created = true;
    let res = await http({
        method: 'POST', url: da('/appbundles'),
        json: { id: opts.id, engine: opts.engine, description: opts.description },
        okStatuses: [409], what: 'Create AppBundle'
    });
    if (res.status === 409) {
        created = false;
        res = await http({
            method: 'POST', url: da(`/appbundles/${opts.id}/versions`),
            json: { engine: opts.engine, description: opts.description },
            what: 'New AppBundle version'
        });
    }
    const version = versionOf(res, 'AppBundle');
    const upload = res.data.uploadParameters;
    if (!upload || typeof upload.endpointURL !== 'string' || !upload.formData || typeof upload.formData !== 'object')
        throw new Error('Design Automation gave no upload parameters for the bundle');
    await http({
        method: 'POST', url: upload.endpointURL, auth: false,
        form: { fields: upload.formData, file: { bytes: opts.zip, fileName: opts.fileName } },
        what: 'AppBundle upload', timeoutMs: 10 * 60 * 1000
    });
    return ({ version: version, created: created, alias: await setAlias(http, 'appbundles', opts.id, opts.alias, version) });
}

/// Posts a new version of an existing activity (the body carries no id: the id is in the path)
/// and points the alias at it.
async function newActivityVersion(http, activity, alias) {
    assertDaId('an activity id', activity && activity.id);
    const body = Object.assign({}, activity);
    delete body.id;
    const res = await http({
        method: 'POST', url: da(`/activities/${activity.id}/versions`), json: body,
        what: 'New Activity version'
    });
    const version = versionOf(res, 'Activity');
    return ({ version: version, created: false, alias: await setAlias(http, 'activities', activity.id, alias, version) });
}

/// Publishes the activity as a new version (creating it the first time) and points the alias at it.
async function publishActivitySpec(http, activity, alias) {
    assertDaId('an activity id', activity && activity.id);
    assertDaId('an alias', alias);
    const res = await http({
        method: 'POST', url: da('/activities'), json: activity,
        okStatuses: [409], what: 'Create Activity'
    });
    if (res.status === 409)
        return (newActivityVersion(http, activity, alias));
    const version = versionOf(res, 'Activity');
    return ({ version: version, created: true, alias: await setAlias(http, 'activities', activity.id, alias, version) });
}

/// The activity as published at owner.id+alias, or null when Design Automation does not know it.
async function getActivity(http, owner, id, alias) {
    assertDaId('the owner', owner);
    assertDaId('an activity id', id);
    assertDaId('an alias', alias);
    const res = await http({
        method: 'GET', url: da(`/activities/${owner}.${id}+${alias}`),
        okStatuses: [404], what: 'Read Activity'
    });
    return (res.status === 404 ? null : res.data);
}

/// The Design Automation owner: APS_DA_NICKNAME when set, else what DA calls this app
/// (its nickname, or its client id when it has none).
async function resolveOwner(http, env) {
    const set = ((env || process.env).APS_DA_NICKNAME || '').trim();
    if (set) {
        assertDaId('APS_DA_NICKNAME', set);
        return (set);
    }
    const res = await http({ method: 'GET', url: da('/forgeapps/me'), what: 'Read nickname' });
    assertDaId('the nickname Design Automation answered', res.data);
    return (res.data);
}

// ---------------------------------------------------------------------------------------------
// The rendered activity: placeholder filling and comparison.

/// Fills a rendered activity's {{owner}} and {{bundleAlias}} and parses it. Both values are checked
/// against the DA id alphabet first, so neither can break out of its JSON string.
function fillActivity(text, values) {
    for (const k of ['owner', 'bundleAlias'])
        assertDaId(k, values[k]);
    const filled = text.replace(/\{\{(owner|bundleAlias)\}\}/g, (m, k) => values[k]);
    const left = /\{\{[^}]*\}\}/.exec(filled);
    if (left !== null)
        throw new Refusal('the activity still holds ' + left[0] + ' after filling {{owner}} and {{bundleAlias}}');
    return (JSON.parse(filled));
}

/// Canonical text: sorted keys, so key order never counts as drift.
function canon(v) {
    if (Array.isArray(v))
        return ('[' + v.map(canon).join(',') + ']');
    if (v !== null && typeof v === 'object')
        return ('{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}');
    return (JSON.stringify(v));
}

/// One parameter as DA might echo it. ASSERTED (DA's GET answer has not been read): DA may omit
/// `required: false` and add `zip: false` / `ondemand: false`, which are its defaults.
function normParam(p) {
    const out = Object.assign({}, p || {});
    if (out.required === undefined)
        out.required = false;
    if (out.zip === false)
        delete out.zip;
    if (out.ondemand === false)
        delete out.ondemand;
    return (out);
}

/// How the published activity differs from the rendered one (placeholders filled): its engine,
/// command line and bundles, then its parameters one by one. [] when they agree.
function diffActivity(rendered, remote) {
    const out = [];
    remote = remote || {};
    for (const field of ['engine', 'commandLine', 'appbundles']) {
        if (canon(rendered[field]) !== canon(remote[field]))
            out.push(`${field}: published ${JSON.stringify(remote[field])}, rendered ${JSON.stringify(rendered[field])}`);
    }
    const mine = rendered.parameters || {};
    const theirs = remote.parameters || {};
    for (const name of Object.keys(mine).sort()) {
        if (!(name in theirs)) {
            out.push(`parameter ${name}: not published`);
            continue;
        }
        const a = normParam(mine[name]);
        const b = normParam(theirs[name]);
        const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).sort();
        for (const k of keys) {
            if (canon(a[k]) !== canon(b[k]))
                out.push(`parameter ${name}.${k}: published ${JSON.stringify(b[k])}, rendered ${JSON.stringify(a[k])}`);
        }
    }
    for (const name of Object.keys(theirs).sort()) {
        if (!(name in mine))
            out.push(`parameter ${name}: published but not rendered`);
    }
    return (out);
}

// ---------------------------------------------------------------------------------------------
// The add-ins under ADDINS_ROOT.

function readJson(file) {
    return (JSON.parse(_fs.readFileSync(file, 'utf8')));
}

/// Every add-in under the root that has an addin.json, sorted by id:
/// { id, version, enabled, engine, description, tasks: [...], dir, bundleZip, hasBundleZip }.
function listAddins(addinsRoot) {
    if (!_fs.existsSync(addinsRoot))
        throw new Refusal(`no add-ins folder at ${addinsRoot}. Set ADDINS_ROOT to the parent repo's revit/addins.`);
    return (_fs.readdirSync(addinsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && _fs.existsSync(_path.join(addinsRoot, d.name, 'addin.json')))
        .map((d) => {
            const dir = _path.join(addinsRoot, d.name);
            const m = readJson(_path.join(dir, 'addin.json'));
            if (m.id !== d.name)
                throw new Refusal(`${d.name}/addin.json names the add-in ${JSON.stringify(m.id)}; the id must equal its folder name`);
            const bundleZip = _path.join(dir, 'dist', m.id + '.zip');
            return ({
                id: m.id,
                version: m.version,
                enabled: m.enabled === true,
                engine: m.engine,
                description: m.description,
                tasks: Object.keys(m.tasks || {}).sort(),
                dir: dir,
                bundleZip: bundleZip,
                hasBundleZip: _fs.existsSync(bundleZip)
            });
        })
        .sort((a, b) => a.id.localeCompare(b.id)));
}

function findEnabledAddin(addinsRoot, id) {
    const all = listAddins(addinsRoot);
    const a = all.find((x) => x.id === id);
    if (!a)
        throw new Refusal(`no add-in ${id} under ${addinsRoot} (found: ${all.map((x) => x.id).join(', ') || 'none'})`);
    if (!a.enabled)
        throw new Refusal(`${id} is disabled in its addin.json ("enabled": false); only enabled add-ins are published`);
    return (a);
}

/// The rendered activity text for one task, after checking it is there and named as the contract says.
function readRenderedActivity(addin, task) {
    const file = _path.join(addin.dir, 'activities', task + '.json');
    if (!_fs.existsSync(file))
        throw new Refusal(`${addin.id} has no rendered activity for its task ${task} (looked for ${file}). Render the add-ins in the parent repo first.`);
    const text = _fs.readFileSync(file, 'utf8');
    const id = JSON.parse(text).id;
    // revit/tools/contracts/activity-naming.md: <Addin>_<task>_v<MAJOR>.
    if (typeof id !== 'string' || !new RegExp(`^${addin.id}_${task}_v[0-9]+$`).test(id))
        throw new Refusal(`${file} has the id ${JSON.stringify(id)}; it must be ${addin.id}_${task}_v<MAJOR>. Render the add-ins in the parent repo again.`);
    return (text);
}

// ---------------------------------------------------------------------------------------------
// The three commands. Each writes plain-English lines to out(line) and answers an exit code:
// 0 done or no drift, 1 drift; a Refusal or any other Error is thrown to the caller.

/// createPublisher({ http, addinsRoot?, owner?, out? }). `owner` is a string or an async
/// function answering one; it is asked for only when a command needs it.
function createPublisher(opts) {
    const http = opts.http;
    const addinsRoot = opts.addinsRoot || DEFAULT_ADDINS_ROOT;
    const out = opts.out || ((line) => console.log(line));
    let ownerValue = null;
    async function owner() {
        if (ownerValue === null)
            ownerValue = typeof opts.owner === 'function' ? await opts.owner() : (opts.owner || await resolveOwner(http));
        assertDaId('the owner', ownerValue);
        return (ownerValue);
    }

    /// Checks revit/addins/<Id>/dist/<Id>.zip, publishes it as a new version, moves the alias.
    async function publishBundle(args) {
        const alias = checkAlias(args.alias || 'dev');
        const a = findEnabledAddin(addinsRoot, args.addin);
        if (!a.hasBundleZip)
            throw new Refusal(`${a.bundleZip} does not exist. Build it on Windows first: revit/tools/build-bundle.ps1 -Addin ${a.id}`);
        const zip = new Uint8Array(_fs.readFileSync(a.bundleZip));
        const sha = _crypto.createHash('sha256').update(zip).digest('hex');
        out(`zip:    ${a.bundleZip}  ${zip.length} bytes  sha256 ${sha}`);
        const check = checkBundleZip(zip, a.id);
        for (const e of check.entries)
            out(`  ${e.name}  ${e.size} bytes`);
        if (check.problems.length > 0) {
            for (const p of check.problems)
                out(`  problem: ${p}`);
            throw new Refusal(`${check.problems.length} problem(s) in the zip; nothing was uploaded`);
        }
        out('check:  passed');
        if (args.checkOnly)
            return (0);
        const who = await owner();
        const result = await publishAppBundleZip(http, {
            id: a.id,
            engine: a.engine,
            description: `${a.description || a.id} (${a.id} ${a.version}, sha256 ${sha.substring(0, 12)})`,
            zip: zip,
            fileName: a.id + '.zip',
            alias: alias
        });
        out(`${result.created ? 'Created' : 'Published'} ${who}.${a.id} version ${result.version}; alias ${alias} ${result.alias} to it.`);
        return (0);
    }

    /// Each (or one) task's rendered activity, filled in, as a new version; alias moved.
    async function publishActivity(args) {
        const alias = checkAlias(args.alias || 'dev');
        const bundleAlias = checkAlias(args.bundleAlias || alias);
        const a = findEnabledAddin(addinsRoot, args.addin);
        if (args.task && !a.tasks.includes(args.task))
            throw new Refusal(`${a.id} has no task ${args.task} (has: ${a.tasks.join(', ')})`);
        const tasks = args.task ? [args.task] : a.tasks;
        const texts = tasks.map((t) => readRenderedActivity(a, t));
        const who = await owner();
        const activities = texts.map((text) => fillActivity(text, { owner: who, bundleAlias: bundleAlias }));
        if (args.dryRun) {
            out(JSON.stringify(activities.length === 1 ? activities[0] : activities, null, 2));
            return (0);
        }
        for (const act of activities) {
            const res = await publishActivitySpec(http, act, alias);
            out(`${res.created ? 'Created' : 'Published'} ${who}.${act.id} version ${res.version} (runs ${act.appbundles.join(', ')}); alias ${alias} ${res.alias} to it.`);
        }
        return (0);
    }

    /// Every task of every ENABLED add-in, read from DA at owner.<activity>+<alias> and compared
    /// with the rendered file. Changes nothing. 1 on any drift or any activity DA does not know.
    async function checkRemote(args) {
        const alias = checkAlias(args.alias || 'dev');
        const bundleAlias = checkAlias(args.bundleAlias || alias);
        const who = await owner();
        let drift = 0;
        let checked = 0;
        for (const a of listAddins(addinsRoot).filter((x) => x.enabled)) {
            for (const task of a.tasks) {
                const rendered = fillActivity(readRenderedActivity(a, task), { owner: who, bundleAlias: bundleAlias });
                const name = `${who}.${rendered.id}+${alias}`;
                checked++;
                const remote = await getActivity(http, who, rendered.id, alias);
                if (remote === null) {
                    drift++;
                    out(`DRIFT  ${name}: Design Automation does not know it (npm run publish:activity -- --addin ${a.id} --task ${task} --alias ${alias})`);
                    continue;
                }
                const d = diffActivity(rendered, remote);
                if (d.length === 0) {
                    out(`ok     ${name}`);
                } else {
                    drift++;
                    out(`DRIFT  ${name}:`);
                    for (const line of d)
                        out(`         ${line}`);
                }
            }
        }
        out(`check-remote: ${checked} ${checked === 1 ? 'activity' : 'activities'} at +${alias}, ${drift} drifted.`);
        return (drift === 0 ? 0 : 1);
    }

    return ({ publishBundle, publishActivity, checkRemote, owner });
}

module.exports = {
    ALIASES,
    DA_BASE,
    DEFAULT_ADDINS_ROOT,
    Refusal,
    addinsRootFromEnv,
    appTokenGetter,
    createPublisher,
    diffActivity,
    fillActivity,
    getActivity,
    listAddins,
    liveHttp,
    newActivityVersion,
    publishActivitySpec,
    publishAppBundleZip,
    resolveOwner,
    setAlias
};
