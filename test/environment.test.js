// routes/common/environment.js: every page call names its APS environment, and that name alone picks
// the app it reaches. These pin that an unnamed or unconfigured environment reaches none, and that
// prod refuses a change unless its name was typed, so a wrong click cannot land on the client's app.

const test = require('node:test');
const assert = require('node:assert/strict');

// config.js reads the environment once, when first required, so each setup is loaded afresh with
// exactly the APS variables named and none left over from the shell.
function load(vars) {
    for (const name of Object.keys(process.env).filter((k) => /^APS_([A-Z]+_)?CLIENT_(ID|SECRET)$/.test(k)))
        delete process.env[name];
    Object.assign(process.env, vars);
    for (const file of ['../config', '../routes/common/environment'])
        delete require.cache[require.resolve(file)];
    return (require('../routes/common/environment'));
}

const { confirmChange, describeEnvironments, requireEnvironment } = load({
    APS_DEV_CLIENT_ID: 'dev-id', APS_DEV_CLIENT_SECRET: 'dev-secret',
    APS_UAT_CLIENT_ID: 'uat-id',
    APS_PROD_CLIENT_ID: 'prod-id', APS_PROD_CLIENT_SECRET: 'prod-secret'
});

/// Runs one middleware; answers 'next' when it passed the request on, else { status, body }.
function run(middleware, method, headers, req) {
    req = Object.assign(req || {}, { method: method, get: (h) => headers[h] });
    let answer = null;
    const res = {
        status: (status) => ({ json: (body) => { answer = { status: status, body: body }; } })
    };
    middleware(req, res, () => { answer = 'next'; });
    return ({ answer: answer, req: req });
}

test.describe('describeEnvironments', () => {
    test.it('lists all four in order, configured only when both variables are set', () => {
        const envs = describeEnvironments();
        assert.deepEqual(envs.map((e) => [e.name, e.configured, e.guarded]), [
            ['dev', true, false], ['testing', false, false], ['uat', false, false], ['prod', true, true]
        ]);
        assert.deepEqual(envs[2].missing, ['APS_UAT_CLIENT_SECRET']);
        assert.deepEqual(envs[1].missing, ['APS_TESTING_CLIENT_ID', 'APS_TESTING_CLIENT_SECRET']);
    });

    test.it('never carries a credential value', () => {
        const text = JSON.stringify(describeEnvironments());
        for (const value of ['dev-id', 'dev-secret', 'uat-id', 'prod-id', 'prod-secret'])
            assert.equal(text.includes(value), false, value);
    });
});

test.describe('requireEnvironment', () => {
    test.it('passes a configured environment on as req.apsEnv', () => {
        const { answer, req } = run(requireEnvironment, 'GET', { 'X-APS-Env': 'dev' });
        assert.equal(answer, 'next');
        assert.equal(req.apsEnv, 'dev');
    });

    test.it('refuses no header, an unknown name and a half-configured environment', () => {
        for (const env of [undefined, 'staging', 'uat', 'testing']) {
            const { answer } = run(requireEnvironment, 'GET', { 'X-APS-Env': env });
            assert.equal(answer.status, 400, String(env));
            assert.match(answer.body.diagnostic, /configured: dev, prod$/);
        }
    });
});

// The page treats APS_CLIENT_ID's app as a separate one; dev borrows it only as a stand-in.
test.describe('dev standing in on APS_CLIENT_ID', () => {
    const cli = { APS_CLIENT_ID: 'cli-id', APS_CLIENT_SECRET: 'cli-secret' };

    test.it('borrows the pair when neither APS_DEV_* is set', () => {
        const env = load(cli);
        const dev = env.describeEnvironments()[0];
        assert.deepEqual([dev.configured, dev.borrowed], [true, true]);
        assert.deepEqual(dev.missing, ['APS_DEV_CLIENT_ID', 'APS_DEV_CLIENT_SECRET']);
        assert.equal(env.findEnvironment('dev').client_id, 'cli-id');
        assert.equal(JSON.stringify(env.describeEnvironments()).includes('cli-'), false);
    });

    test.it('never mixes a half-set dev pair with the borrowed one', () => {
        for (const half of [{ APS_DEV_CLIENT_ID: 'dev-id' }, { APS_DEV_CLIENT_SECRET: 'dev-secret' }]) {
            const dev = load(Object.assign({}, cli, half)).describeEnvironments()[0];
            assert.deepEqual([dev.configured, dev.borrowed], [false, false], Object.keys(half)[0]);
        }
    });

    test.it('uses dev\'s own pair once it is set', () => {
        const env = load(Object.assign({ APS_DEV_CLIENT_ID: 'dev-id', APS_DEV_CLIENT_SECRET: 'dev-secret' }, cli));
        assert.equal(env.describeEnvironments()[0].borrowed, false);
        assert.equal(env.findEnvironment('dev').client_id, 'dev-id');
    });

    test.it('stays unconfigured when the borrowed pair is incomplete too', () => {
        const dev = load({ APS_CLIENT_ID: 'cli-id' }).describeEnvironments()[0];
        assert.equal(dev.configured, false);
    });

    test.it('is dev only: testing, uat and prod never borrow', () => {
        const envs = load(cli).describeEnvironments();
        assert.deepEqual(envs.slice(1).map((e) => [e.name, e.configured, e.borrowed]),
            [['testing', false, false], ['uat', false, false], ['prod', false, false]]);
    });
});

test.describe('confirmChange', () => {
    const guard = (method, env, confirm) => run(confirmChange, method, { 'X-APS-Confirm': confirm }, { apsEnv: env }).answer;

    test.it('refuses a change to prod without its name typed', () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            assert.equal(guard(method, 'prod', undefined).status, 403, method);
            assert.equal(guard(method, 'prod', 'dev').status, 403, method);
        }
    });

    test.it('passes a confirmed change to prod, a read of prod and any change to dev', () => {
        assert.equal(guard('DELETE', 'prod', 'prod'), 'next');
        assert.equal(guard('GET', 'prod', undefined), 'next');
        assert.equal(guard('POST', 'dev', undefined), 'next');
    });
});
