// Command line for lib/publish.js. Run through npm, which loads .env when it exists:
//
//   npm run publish:bundle   -- --addin <Id> [--alias dev] [--check-only]
//   npm run publish:activity -- --addin <Id> [--task <task>] [--alias dev] [--bundle-alias <a>] [--dry-run]
//   npm run check:remote     -- [--alias dev] [--bundle-alias <a>]
//
// Exit codes: 0 done (or no drift), 1 failed (or drift found), 2 refused before anything was sent.

const { parseArgs } = require('util');
const publish = require('../lib/publish');

const USAGE = `Usage:
  npm run publish:bundle   -- --addin <Id> [--alias dev|uat|prod] [--check-only]
  npm run publish:activity -- --addin <Id> [--task <task>] [--alias dev|uat|prod] [--bundle-alias <alias>] [--dry-run]
  npm run check:remote     -- [--alias dev|uat|prod] [--bundle-alias <alias>]
Add-ins are read from ADDINS_ROOT (default: ../addins, the parent repo's revit/addins).`;

// The token client is built only when a request is actually made, so --check-only needs no settings.
function lazyHttp() {
    let live = null;
    return (async (req) => {
        if (live === null) {
            for (const name of ['APS_CLIENT_ID', 'APS_CLIENT_SECRET']) {
                if (!(process.env[name] || '').trim())
                    throw new publish.Refusal(`${name} is not set. Put it in this app's .env (see .env.example) or export it.`);
            }
            live = publish.liveHttp(publish.appTokenGetter());
        }
        return (live(req));
    });
}

function usageError(message) {
    const ex = new publish.Refusal(message);
    ex.showUsage = true;
    return (ex);
}

async function main(argv) {
    const command = argv[0];
    const { values } = parseArgs({
        args: argv.slice(1),
        options: {
            'addin': { type: 'string' },
            'task': { type: 'string' },
            'alias': { type: 'string', default: 'dev' },
            'bundle-alias': { type: 'string' },
            'check-only': { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false }
        },
        strict: true
    });
    const publisher = publish.createPublisher({
        http: lazyHttp(),
        addinsRoot: publish.addinsRootFromEnv(),
        out: (line) => console.log(line)
    });
    const needAddin = () => {
        if (!values.addin)
            throw usageError('--addin <Id> is required');
        return (values.addin);
    };
    switch (command) {
        case 'bundle':
            return (publisher.publishBundle({ addin: needAddin(), alias: values.alias, checkOnly: values['check-only'] }));
        case 'activity':
            return (publisher.publishActivity({
                addin: needAddin(), task: values.task, alias: values.alias,
                bundleAlias: values['bundle-alias'], dryRun: values['dry-run']
            }));
        case 'check-remote':
            return (publisher.checkRemote({ alias: values.alias, bundleAlias: values['bundle-alias'] }));
        default:
            throw usageError(`unknown command ${JSON.stringify(command)}`);
    }
}

main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((ex) => {
        // A bad flag from parseArgs is a refusal too: nothing was sent.
        const badArgs = ex && typeof ex.code === 'string' && ex.code.startsWith('ERR_PARSE_ARGS');
        const refused = badArgs || ex instanceof publish.Refusal;
        console.error((refused ? 'Refused: ' : 'Failed: ') + ex.message);
        if (badArgs || ex.showUsage)
            console.error(USAGE);
        process.exit(refused ? 2 : 1);
    });
