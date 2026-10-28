const config = require('../../config');

// The page names the APS environment of every call in the X-APS-Env header. Each environment is its
// own APS app, so the token, the Design Automation client and the owner are all picked by that name.

function variablesOf(name) {
    const prefix = `APS_${name.toUpperCase()}_`;
    return ([prefix + 'CLIENT_ID', prefix + 'CLIENT_SECRET']);
}

/// The environment called `name` when both its variables are set, else null.
function findEnvironment(name) {
    return (config.environments.find((e) => e.name === name && e.client_id && e.client_secret) || null);
}

/// Every environment, for the page's switcher. Names the unset variables, never a value. borrowed
/// marks dev running on APS_CLIENT_ID's app because its own pair is unset.
function describeEnvironments() {
    return (config.environments.map((e) => ({
        name: e.name,
        configured: findEnvironment(e.name) !== null,
        borrowed: e.borrowed,
        guarded: e.guarded,
        missing: e.missing
    })));
}

/// Sets req.apsEnv to the environment the request names, or answers 400 when it names none that
/// is configured.
function requireEnvironment(req, res, next) {
    const env = findEnvironment(req.get('X-APS-Env'));
    if (!env)
        return (res.status(400).json({
            diagnostic: 'Pick an APS environment; configured: '
                + (config.environments.filter((e) => findEnvironment(e.name)).map((e) => e.name).join(', ') || 'none')
        }));
    req.apsEnv = env.name;
    next();
}

/// Answers 403 to a change (anything but GET or HEAD) to a guarded environment unless X-APS-Confirm
/// carries its name, which the page sends only once the user has typed it. Runs after
/// requireEnvironment.
function confirmChange(req, res, next) {
    const env = findEnvironment(req.apsEnv);
    if (env.guarded && req.method !== 'GET' && req.method !== 'HEAD' && req.get('X-APS-Confirm') !== env.name)
        return (res.status(403).json({ diagnostic: `A change to ${env.name} needs "${env.name}" typed to confirm` }));
    next();
}

module.exports = {
    confirmChange,
    describeEnvironments,
    findEnvironment,
    requireEnvironment,
    variablesOf
};
