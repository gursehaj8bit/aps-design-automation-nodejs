const express = require('express');
const publish = require('../lib/publish');
const { confirmChange, requireEnvironment } = require('./common/environment');

// The add-ins rendered in the parent repo's revit/addins (ADDINS_ROOT), and the three publish
// commands as POSTs for the page's "Publish add-in" dialog. The same code as `npm run publish:*`,
// but on the app of the environment the page picked rather than APS_CLIENT_ID's.
const router = express.Router();
const addinsRoot = publish.addinsRootFromEnv();
const https = {};

function httpFor(env) {
    return (https[env] = https[env] || publish.liveHttp(publish.appTokenGetter(env)));
}

// check-remote only compares, so it is the one command a guarded environment runs unconfirmed.
function confirmUnlessCheck(req, res, next) {
    return ((req.body || {}).command === 'check-remote' ? next() : confirmChange(req, res, next));
}

/// <summary>
/// Every add-in under ADDINS_ROOT, enabled or not, with its tasks and whether its bundle zip is built.
/// </summary>
router.get('/addins', (req, res) => {
    try {
        res.json({
            addinsRoot: addinsRoot,
            aliases: publish.ALIASES,
            addins: publish.listAddins(addinsRoot).map((a) => ({
                id: a.id, version: a.version, enabled: a.enabled, tasks: a.tasks, hasBundleZip: a.hasBundleZip
            }))
        });
    } catch (ex) {
        console.error(ex);
        res.status(ex instanceof publish.Refusal ? 400 : 500).json({ diagnostic: ex.message });
    }
});

/// <summary>
/// Runs one command: body { command: 'bundle' | 'activity' | 'check-remote', addin, task?, alias }.
/// Answers { code, lines }; code 1 from check-remote means drift was found.
/// </summary>
router.post('/addins/publish', requireEnvironment, confirmUnlessCheck, async (req, res) => {
    const body = req.body || {};
    const lines = [];
    const http = httpFor(req.apsEnv);
    // The owner is asked of this environment's app: APS_DA_NICKNAME names the command-line app's.
    const publisher = publish.createPublisher({
        http: http, addinsRoot: addinsRoot, owner: () => publish.resolveOwner(http, {}), out: (l) => lines.push(l)
    });
    try {
        let code;
        if (body.command === 'bundle')
            code = await publisher.publishBundle({ addin: body.addin, alias: body.alias });
        else if (body.command === 'activity')
            code = await publisher.publishActivity({ addin: body.addin, task: body.task || undefined, alias: body.alias });
        else if (body.command === 'check-remote')
            code = await publisher.checkRemote({ alias: body.alias });
        else
            throw new publish.Refusal('unknown command ' + JSON.stringify(body.command));
        res.json({ code: code, lines: lines });
    } catch (ex) {
        console.error(ex);
        res.status(ex instanceof publish.Refusal ? 400 : 500).json({ diagnostic: ex.message, lines: lines });
    }
});

module.exports = router;
