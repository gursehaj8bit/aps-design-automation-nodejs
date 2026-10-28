const _path = require('path');
const _fs = require('fs');
const _url = require('url');
const express = require('express');
//const http = require('http');
const http = require('https');
const formdata = require('form-data');
const bodyParser = require('body-parser');
const multer = require('multer');
const router = express.Router();
const { getClient } = require('./common/oauth');
const { confirmChange, describeEnvironments, findEnvironment, requireEnvironment, variablesOf } = require('./common/environment');
const config = require('../config');
const dav3 = require('autodesk.forge.designautomation');
const ForgeAPI = require('forge-apis');
const publish = require('../lib/publish');

router.use(bodyParser.json());

/// <summary>
/// The environments for the page's switcher. Above the middleware, as it is asked before one is picked.
/// </summary>
router.get('/aps/environments', (req, res) => {
    res.json(describeEnvironments());
});

// Middleware for obtaining a token for each request, from the APS app of the environment it names.
router.use(requireEnvironment, confirmChange, async (req, res, next) => {
    req.oauth_client = await getClient(/*config.scopes.internal*/undefined, req.apsEnv);
    if (!req.oauth_client)
        return (res.status(502).json({
            diagnostic: `Could not get an APS token for ${req.apsEnv}. Check ${variablesOf(req.apsEnv).join(' and ')}.`
        }));
    req.oauth_token = req.oauth_client.getCredentials();
    next();
});

// Static instances of the DA API, one per environment, as each refreshes its own app's token
let dav3Instances = {};

class Utils {

    static async Instance(env) {
        if (!dav3Instances[env]) {
            // Here it is ok to not await since we awaited in the call router.use()
            const dav3Instance = dav3Instances[env] = new dav3.AutodeskForgeDesignAutomationClient(config.client);
            let FetchRefresh = async (data) => { // data is undefined in a fetch, but contains the old credentials in a refresh
                let client = await getClient(undefined, env);
                let credentials = client.getCredentials();
                // The line below is for testing
                //credentials.expires_in = 30; credentials.expires_at = new Date(Date.now() + credentials.expires_in * 1000);
                return (credentials);
            };
            dav3Instance.authManager.authentications['2-legged'].fetchToken = FetchRefresh;
            dav3Instance.authManager.authentications['2-legged'].refreshToken = FetchRefresh;
        }
        return (dav3Instances[env]);
    }

    /// <summary>
    /// Returns the directory where bindles are stored on the local machine.
    /// </summary>
    static get LocalBundlesFolder() {
        return (_path.resolve(_path.join(__dirname, '../', 'bundles')));
    }

    /// <summary>
    /// Prefix for AppBundles and Activities: the client id of the environment's app
    /// </summary>
    static NickName(env) {
        return (findEnvironment(env).client_id);
    }

    /// <summary>
    /// Alias for the app (e.g. DEV, STG, PROD). This value may come from an environment variable
    /// </summary>
    static get Alias() {
        return ('dev');
    }

    /// <summary>
    /// Search files in a folder and filter them.
    /// </summary>
    static async findFiles(dir, filter) {
        return (new Promise((fulfill, reject) => {
            _fs.readdir(dir, (err, files) => {
                if (err)
                    return (reject(err));
                if (filter !== undefined && typeof filter === 'string')
                    files = files.filter((file) => {
                        return (_path.extname(file) === filter);
                    });
                else if (filter !== undefined && typeof filter === 'object')
                    files = files.filter((file) => {
                        return (filter.test(file));
                    });
                fulfill(files);
            });
        }));
    }

    /// <summary>
    /// Create a new DAv3 client/API with default settings, on the app of the named environment
    /// </summary>
    static async dav3API(env) {
        // There is 2 alternatives to setup an API instance, providing the access_token directly
        // let apiClient2 = new dav3.AutodeskForgeDesignAutomationClient(/*config.client*/);
        // apiClient2.authManager.authentications['2-legged'].accessToken = oauth2.access_token;
        //return (new dav3.AutodeskForgeDesignAutomationApi(apiClient));

        // Or use the Auto-Refresh feature
        let apiClient = await Utils.Instance(env);
        return (new dav3.AutodeskForgeDesignAutomationApi(apiClient));
    }

    /// <summary>
    /// Helps identify the engine
    /// </summary>
    static EngineAttributes(engine) {
        if (engine.includes('3dsMax'))
            return ({
                commandLine: '$(engine.path)\\3dsmaxbatch.exe -sceneFile "$(args[inputFile].path)" "$(settings[script].path)"',
                extension: 'max',
                script: "da = dotNetClass(\'Autodesk.Forge.Sample.DesignAutomation.Max.RuntimeExecute\')\nda.ModifyWindowWidthHeight()\n"
            });
        if (engine.includes('AutoCAD'))
            return ({
                commandLine: '$(engine.path)\\accoreconsole.exe /i "$(args[inputFile].path)" /al "$(appbundles[{0}].path)" /s "$(settings[script].path)"',
                extension: 'dwg',
                script: "UpdateParam\n"
            });
        if (engine.includes('Inventor'))
            return ({
                commandLine: '$(engine.path)\\InventorCoreConsole.exe /i "$(args[inputFile].path)" /al "$(appbundles[{0}].path)"',
                extension: 'ipt',
                script: ''
            });
        if (engine.includes('Revit'))
            return ({
                commandLine: '$(engine.path)\\revitcoreconsole.exe /i "$(args[inputFile].path)" /al "$(appbundles[{0}].path)"',
                extension: 'rvt',
                script: ''
            });

        throw new Error('Invalid engine');
    }

    static FormDataLength(form) {
        return (new Promise((fulfill, reject) => {
            form.getLength((err, length) => {
                if (err)
                    return (reject(err));
                fulfill(length);
            });
        }));
    }

    /// <summary>
    /// Upload a file
    /// </summary>
    static uploadFormDataWithFile(filepath, endpoint, params = null) {
        return (new Promise(async (fulfill, reject) => {
            const fileStream = _fs.createReadStream(filepath);

            const form = new formdata();
            if (params) {
                const keys = Object.keys(params);
                for (let i = 0; i < keys.length; i++)
                    form.append(keys[i], params[keys[i]]);
            }
            form.append('file', fileStream);

            let headers = form.getHeaders();
            headers['Cache-Control'] = 'no-cache';
            headers['Content-Length'] = await Utils.FormDataLength(form);

            const urlinfo = _url.parse(endpoint);
            const postReq = http.request({
                host: urlinfo.host,
                port: (urlinfo.port || (urlinfo.protocol === 'https:' ? 443 : 80)),
                path: urlinfo.pathname,
                method: 'POST',
                headers: headers
            },
                response => {
                    fulfill(response.statusCode);
                },
                err => {
                    reject(err);
                }
            );

            form.pipe(postReq);
        }));
    }
}

/// <summary>
/// Names of app bundles on this project
/// </summary>
router.get('/appbundles', async /*GetLocalBundles*/(req, res) => {
    // this folder is placed under the public folder, which may expose the bundles
    // but it was defined this way so it be published on most hosts easily
    let bundles = await Utils.findFiles(Utils.LocalBundlesFolder, '.zip');
    bundles = bundles.map((fn) => _path.basename(fn, '.zip'));
    res.json(bundles);
});

/// <summary>
/// Return a list of available engines
/// </summary>
router.get('/aps/designautomation/engines', async /*GetAvailableEngines*/(req, res) => {
    let that = this;
    let Allengines = [];
    let paginationToken = null;
    try {
        const api = await Utils.dav3API(req.apsEnv);
        while (true) {
            let engines = await api.getEngines({ 'page': paginationToken });
            Allengines = Allengines.concat(engines.data)
            if (engines.paginationToken == null) break;
            paginationToken = engines.paginationToken;
        }
        res.json(Allengines.sort()); // return list of engines
    } catch (ex) {
        console.error(ex);
        res.json([]);
    }

});

/// <summary>
/// Define a new appbundle
/// </summary>
router.post('/aps/designautomation/appbundles', async /*CreateAppBundle*/(req, res) => {
    const appBundleSpecs = req.body;

    // basic input validation
    const zipFileName = appBundleSpecs.zipFileName;
    const engineName = appBundleSpecs.engine;

    // standard name for this sample
    const appBundleName = zipFileName + 'AppBundle';

    // check if ZIP with bundle is here
    const packageZipPath = _path.join(Utils.LocalBundlesFolder, zipFileName + '.zip');

    // get defined app bundles
    const api = await Utils.dav3API(req.apsEnv);
    let appBundles = null;
    try {
        appBundles = await api.getAppBundles();
    } catch (ex) {
        console.error(ex);
        return (res.status(500).json({
            diagnostic: 'Failed to get the Bundle list'
        }));
    }
    // check if app bundle is already define
    let newAppVersion = null;
    const qualifiedAppBundleId = `${Utils.NickName(req.apsEnv)}.${appBundleName}+${Utils.Alias}`;
    if (!appBundles.data.includes(qualifiedAppBundleId)) {
        // create an appbundle (version 1)
        // const appBundleSpec = {
        //         package: appBundleName,
        //         engine: engineName,
        //         id: appBundleName,
        //         description: `Description for ${appBundleName}`
        //     };
        const appBundleSpec = dav3.AppBundle.constructFromObject({
            package: appBundleName,
            engine: engineName,
            id: appBundleName,
            description: `Description for ${appBundleName}`
        });
        try {
            newAppVersion = await api.createAppBundle(appBundleSpec);
        } catch (ex) {
            console.error(ex);
            return (res.status(500).json({
                diagnostic: 'Cannot create new app'
            }));
        }

        // create alias pointing to v1
        const aliasSpec = //dav3.Alias.constructFromObject({
        {
            id: Utils.Alias,
            version: 1
        };
        try {
            const newAlias = await api.createAppBundleAlias(appBundleName, aliasSpec);
        } catch (ex) {
            console.error(ex);
            return (res.status(500).json({
                diagnostic: 'Failed to create an alias'
            }));
        }
    } else {
        // create new version
        const appBundleSpec = //dav3.AppBundle.constructFromObject({
        {
            engine: engineName,
            description: appBundleName
        };
        try {
            newAppVersion = await api.createAppBundleVersion(appBundleName, appBundleSpec);
        } catch (ex) {
            console.error(ex);
            return (res.status(500).json({
                diagnostic: 'Cannot create new version'
            }));
        }

        // update alias pointing to v+1
        const aliasSpec = //dav3.AliasPatch.constructFromObject({
        {
            version: newAppVersion.version
        };
        try {
            const newAlias = await api.modifyAppBundleAlias(appBundleName, Utils.Alias, aliasSpec);
        } catch (ex) {
            console.error(ex);
            return (res.status(500).json({
                diagnostic: 'Failed to create an alias'
            }));
        }
    }

    // upload the zip with .bundle
    try {
        // curl https://bucketname.s3.amazonaws.com/
        // -F key = apps/myApp/myfile.zip
        // -F content-type = application/octet-stream
        // -F policy = eyJleHBpcmF0aW9uIjoiMjAxOC0wNi0yMVQxMzo...(trimmed)
        // -F x-amz-signature = 800e52d73579387757e1c1cd88762...(trimmed)
        // -F x-amz-credential = AKIAIOSFODNN7EXAMPLE/20180621/us-west-2/s3/aws4_request/
        // -F x-amz-algorithm = AWS4-HMAC-SHA256
        // -F x-amz-date = 20180621T091656Z
        // -F file=@E:myfile.zip
        //
        // The ‘file’ field must be at the end, all fields after ‘file’ will be ignored.
        await Utils.uploadFormDataWithFile(
            packageZipPath,
            newAppVersion.uploadParameters.endpointURL,
            newAppVersion.uploadParameters.formData
        );
    } catch (ex) {
        console.error(ex);
        return (res.status(500).json({
            diagnostic: 'Failed to upload bundle on s3'
        }));
    }

    res.status(200).json({
        appBundle: qualifiedAppBundleId,
        version: newAppVersion.version
    });
});

/// <summary>
/// CreateActivity a new Activity
/// </summary>
router.post('/aps/designautomation/activities', async /*CreateActivity*/(req, res) => {
    const activitySpecs = req.body;

    // basic input validation
    const zipFileName = activitySpecs.zipFileName;
    const engineName = activitySpecs.engine;

    // standard name for this sample
    const appBundleName = zipFileName + 'AppBundle';
    const activityName = zipFileName + 'Activity';

    // get defined activities
    const api = await Utils.dav3API(req.apsEnv);
    let activities = null;
    try {
        activities = await api.getActivities();
    } catch (ex) {
        console.error(ex);
        return (res.status(500).json({
            diagnostic: 'Failed to get activity list'
        }));
    }
    const qualifiedActivityId = `${Utils.NickName(req.apsEnv)}.${activityName}+${Utils.Alias}`;
    // define the activity
    // ToDo: parametrize for different engines...
    const engineAttributes = Utils.EngineAttributes(engineName);
    const commandLine = engineAttributes.commandLine.replace('{0}', appBundleName);
    const activitySpec = {
        id: activityName,
        appbundles: [`${Utils.NickName(req.apsEnv)}.${appBundleName}+${Utils.Alias}`],
        commandLine: [commandLine],
        engine: engineName,
        parameters: {
            inputFile: {
                description: 'input file',
                localName: '$(inputFile)',
                ondemand: false,
                required: true,
                verb: dav3.Verb.get,
                zip: false
            },
            inputJson: {
                description: 'input json',
                localName: 'params.json',
                ondemand: false,
                required: false,
                verb: dav3.Verb.get,
                zip: false
            },
            outputFile: {
                description: 'output file',
                localName: 'outputFile.' + engineAttributes.extension,
                ondemand: false,
                required: true,
                verb: dav3.Verb.put,
                zip: false
            }
        },
        settings: {
            script: {
                value: engineAttributes.script
            }
        }
    };
    if (!activities.data.includes(qualifiedActivityId)) {
        try {
            const newActivity = await api.createActivity(activitySpec);
        } catch (ex) {
            console.error(ex);
            return (res.status(500).json({
                diagnostic: 'Failed to create new activity'
            }));
        }
        // specify the alias for this Activity
        const aliasSpec = {
            id: Utils.Alias,
            version: 1
        };
        try {
            const newAlias = await api.createActivityAlias(activityName, aliasSpec);
        } catch (ex) {
            console.error(ex);
            return (res.status(500).json({
                diagnostic: 'Failed to create new alias for activity'
            }));
        }
        res.status(200).json({
            activity: qualifiedActivityId
        });
        return;
    }

    // The activity exists: post the spec as a new version and move the alias to it, so a changed
    // engine or command line is published. Nothing is deleted; the old version stays to point back to.
    let published = null;
    try {
        published = await publish.newActivityVersion(publish.liveHttp(async () => req.oauth_token.access_token), activitySpec, Utils.Alias);
    } catch (ex) {
        console.error(ex);
        return (res.status(500).json({
            diagnostic: 'Failed to publish a new version of the activity'
        }));
    }
    res.status(200).json({
        activity: qualifiedActivityId,
        version: published.version
    });
});

/// <summary>
/// Get all Activities defined for this account
/// </summary>
router.get('/aps/designautomation/activities', async /*GetDefinedActivities*/(req, res) => {
    const api = await Utils.dav3API(req.apsEnv);
    // filter list of 
    let activities = null;
    try {
        activities = await api.getActivities();
    } catch (ex) {
        console.error(ex);
        return (res.status(500).json({
            diagnostic: 'Failed to get activity list'
        }));
    }
    let definedActivities = [];
    for (let i = 0; i < activities.data.length; i++) {
        let activity = activities.data[i];
        if (activity.startsWith(Utils.NickName(req.apsEnv)) && activity.indexOf('$LATEST') === -1)
            definedActivities.push(activity.replace(Utils.NickName(req.apsEnv) + '.', ''));
    }

    res.status(200).json(definedActivities);
});

/// <summary>
/// Every activity visible to this account, split into nickname, name and alias.
/// An id reads "nickname.Name+alias"; '$LATEST' is the alias DA keeps pointing at the newest version.
/// </summary>
router.get('/aps/designautomation/activities/all', async /*GetAllActivities*/(req, res) => {
    const api = await Utils.dav3API(req.apsEnv);
    let ids = [];
    let ownNickname = Utils.NickName(req.apsEnv);
    try {
        let page = undefined;
        do {
            const result = await api.getActivities(page ? { page: page } : {});
            ids = ids.concat(result.data);
            page = result.paginationToken;
        } while (page);
        // The app's nickname defaults to its client id but can be set to something else.
        ownNickname = (await api.getNickname('me')) || ownNickname;
    } catch (ex) {
        console.error(ex);
        return (res.status(500).json({
            diagnostic: 'Failed to get activity list'
        }));
    }

    const activities = ids.map((id) => {
        const dot = id.indexOf('.');
        const plus = id.lastIndexOf('+');
        return ({
            id: id,
            nickname: dot === -1 ? '' : id.substring(0, dot),
            name: id.substring(dot + 1, plus === -1 ? id.length : plus),
            alias: plus === -1 ? '' : id.substring(plus + 1)
        });
    }).sort((a, b) => a.nickname.localeCompare(b.nickname) || a.name.localeCompare(b.name) || a.alias.localeCompare(b.alias));

    res.status(200).json({ nickname: ownNickname, activities: activities });
});

/// <summary>
/// Direct To S3 
/// ref : https://aps.autodesk.com/blog/new-feature-support-direct-s3-migration-inputoutput-files-design-automation
/// </summary>

const getObjectId = async (bucketKey, objectKey, req) => {
    try {
        let contentStream = _fs.createReadStream(req.file.path);

        //uploadResources takes an Object or Object array of resource to uplaod with their parameters,
        //we are just passing only one object.
        let uploadResponse = await new ForgeAPI.ObjectsApi().uploadResources(
            bucketKey,
            [
                //object
                {
                    objectKey: objectKey,
                    data: contentStream,
                    length: req.file.size
                }
            ],
            {
                useAcceleration: false, //Whether or not to generate an accelerated signed URL
                minutesExpiration: 20, //The custom expiration time within the 1 to 60 minutes range, if not specified, default is 2 minutes
                onUploadProgress: (data) => console.warn(data) // function (progressEvent) => {}
            },
            req.oauth_client, req.oauth_token,
        );
        //lets check for the first and only entry.
        if (uploadResponse[0].hasOwnProperty('error') && uploadResponse[0].error) {
            throw new Error(uploadResponse[0].completed.reason);
        }
        console.log(uploadResponse[0].completed.objectId);
        return (uploadResponse[0].completed.objectId);
    } catch (ex) {
        console.error("Failed to create ObjectID\n", ex)
        throw ex;
    }
}

/// <summary>
/// Start a new workitem
/// </summary>
router.post('/aps/designautomation/workitems', multer({
    dest: 'uploads/'
}).single('inputFile'), async /*StartWorkitem*/(req, res) => {
    const input = req.body;

    // basic input validation
    const workItemData = JSON.parse(input.data);
    const widthParam = parseFloat(workItemData.width);
    const heigthParam = parseFloat(workItemData.height);
    const activityName = `${Utils.NickName(req.apsEnv)}.${workItemData.activityName}`;
    const browserConnectionId = workItemData.browserConnectionId;

    // save the file on the server
    const ContentRootPath = _path.resolve(_path.join(__dirname, '../..'));
    const fileSavePath = _path.join(ContentRootPath, _path.basename(req.file.originalname));

    // upload file to OSS Bucket
    // 1. ensure bucket existis
    const bucketKey = Utils.NickName(req.apsEnv).toLowerCase() + '-designautomation';
    try {
        let payload = new ForgeAPI.PostBucketsPayload();
        payload.bucketKey = bucketKey;
        payload.policyKey = 'transient'; // expires in 24h
        await new ForgeAPI.BucketsApi().createBucket(payload, {}, req.oauth_client, req.oauth_token);
    } catch (ex) {
        // in case bucket already exists
    }
    // 2. upload inputFile
    const inputFileNameOSS = `${new Date().toISOString().replace(/[-T:\.Z]/gm, '').substring(0, 14)}_input_${_path.basename(req.file.originalname)}`; // avoid overriding
    // prepare workitem arguments
    const bearerToken = ["Bearer", req.oauth_token.access_token].join(" ");
    // 1. input file
    const inputFileArgument = {
        url: await getObjectId(bucketKey, inputFileNameOSS, req),
        headers: { "Authorization": bearerToken }
    };
    // 2. input json
    const inputJson = {
        width: widthParam,
        height: heigthParam
    };
    const inputJsonArgument = {
        url: "data:application/json, " + JSON.stringify(inputJson).replace(/"/g, "'")
    };
    // 3. output file
    const outputFileNameOSS = `${new Date().toISOString().replace(/[-T:\.Z]/gm, '').substring(0, 14)}_output_${_path.basename(req.file.originalname)}`; // avoid overriding  
    const outputFileArgument = {
        url: await getObjectId(bucketKey, outputFileNameOSS, req),
        verb: dav3.Verb.put,
        headers: { "Authorization": bearerToken }
    };

    // prepare & submit workitem
    const workItemSpec = {
        activityId: activityName,
        arguments: {
            inputFile: inputFileArgument,
            inputJson: inputJsonArgument,
            outputFile: outputFileArgument,
        }
    };
    let workItemStatus = null;
    try {
        const api = await Utils.dav3API(req.apsEnv);
        workItemStatus = await api.createWorkItem(workItemSpec);
        monitorWorkItem(req.apsEnv, req.oauth_client, req.oauth_token, workItemStatus.id, browserConnectionId, outputFileNameOSS, inputFileNameOSS);
    } catch (ex) {
        console.error(ex);
        return (res.status(500).json({
            diagnostic: 'Failed to create a workitem'
        }));
    }
    res.status(200).json({
        workItemId: workItemStatus.id
    });
});

async function monitorWorkItem(env, oauthClient, oauthToken, workItemId, browserConnectionId, outputFileName, inputFileName) {
    const socketIO = require('../server').io;
    try {
        while (true) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const api = await Utils.dav3API(env);
            const status = await api.getWorkitemStatus(workItemId);
            const bucketKey = Utils.NickName(env).toLowerCase() + '-designautomation';
            const objectsApi = new ForgeAPI.ObjectsApi();
            socketIO.to(browserConnectionId).emit('onComplete', status);
            if (status.status == 'pending' || status.status === 'inprogress') {
                continue;
            }
            let response = await fetch(status.reportUrl);
            socketIO.to(browserConnectionId).emit('onComplete', await response.text());
            if (status.status === 'success') {
                response = await objectsApi.getS3DownloadURL(bucketKey, outputFileName, { 
                    useAcceleration: false, minutesExpiration: 15 
                }, oauthClient, oauthToken);
                socketIO.to(browserConnectionId).emit('downloadResult', response.body.url);
            } else {
                throw new Error('Work item failed...');
            }
            await objectsApi.deleteObject(bucketKey, inputFileName, oauthClient, oauthToken);
            return;
        }
    } catch (err) {
        console.error(err);
        socketIO.to(browserConnectionId).emit('onError', err);
    }
}

// The two workitem query endpoints are newer than the dav3 SDK, so they are called over plain HTTP.
const DA_BASE_URL = 'https://developer.api.autodesk.com/da/us-east/v3';
// Design Automation answers 400 to a startAfterTime 5 days old or more (it keeps workitems for
// 3 days). Longer windows are cut to this, with a margin for clock skew.
const MAX_LOOKBACK_SECONDS = 5 * 24 * 3600 - 300;
// POST workitems/status answers 400 to more than 50 ids.
const STATUS_BATCH_SIZE = 50;
// Queue positions take one GET per workitem; this many go out at once, so a long queue does not
// arrive at Design Automation as a single burst.
const POSITION_BATCH_SIZE = 10;
// A workitem names its activity but not its engine, so the engine comes from the activity. An
// alias can be moved to a version on another engine, so a looked-up engine is kept only this long.
const ACTIVITY_ENGINE_TTL_MS = 10 * 60 * 1000;
const activityEngines = new Map();

async function activityEngine(activityId, oauthToken) {
    const cached = activityEngines.get(activityId);
    if (cached && Date.now() - cached.at < ACTIVITY_ENGINE_TTL_MS)
        return (cached.engine);
    const activity = await daRequest(`${DA_BASE_URL}/activities/${encodeURIComponent(activityId)}`, oauthToken);
    activityEngines.set(activityId, { engine: activity.engine, at: Date.now() });
    return (activity.engine);
}

async function daRequest(url, oauthToken, options = {}) {
    const response = await fetch(url, Object.assign({}, options, {
        headers: Object.assign({ Authorization: 'Bearer ' + oauthToken.access_token }, options.headers)
    }));
    if (!response.ok)
        throw new Error(`${options.method || 'GET'} ${url} answered ${response.status}: ${await response.text()}`);
    return (response.json());
}

/// The coarse group a workitem status falls into; the page filters on these.
function workitemGroup(status) {
    if (status === 'pending' || status === 'inprogress')
        return ('running');
    if (status === 'success')
        return ('success');
    if (status === 'cancelled')
        return ('cancelled');
    if (status && status.startsWith('failed'))
        return ('failed');
    return ('unknown');
}

/// <summary>
/// Every workitem Design Automation still holds that changed in the last ?days= days, newest
/// first, each tagged with a group (running, success, failed, cancelled) for the page to filter on.
/// A pending workitem also carries approximateQueuePosition (1 = next to run, null = unknown).
/// </summary>
router.get('/aps/designautomation/workitems', async /*GetWorkitems*/(req, res) => {
    const days = parseFloat(req.query.days) > 0 ? parseFloat(req.query.days) : 1;
    const lookback = Math.min(Math.round(days * 24 * 3600), MAX_LOOKBACK_SECONDS);
    const startAfterTime = Math.floor(Date.now() / 1000) - lookback;

    let workitems = [];
    try {
        let ids = [];
        let page = null;
        do {
            const listing = await daRequest(`${DA_BASE_URL}/workitems?startAfterTime=${startAfterTime}`
                + (page ? '&page=' + encodeURIComponent(page) : ''), req.oauth_token);
            ids = ids.concat(listing.data.map((w) => w.id));
            page = listing.paginationToken;
        } while (page);

        for (let i = 0; i < ids.length; i += STATUS_BATCH_SIZE) {
            const statuses = await daRequest(`${DA_BASE_URL}/workitems/status`, req.oauth_token, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ids.slice(i, i + STATUS_BATCH_SIZE))
            });
            workitems = workitems.concat(statuses.results);
        }
    } catch (ex) {
        console.error(ex);
        return (res.status(500).json({
            diagnostic: 'Failed to get workitem list'
        }));
    }

    // Only GET workitems/{id} reports a queue position, and only while the workitem is pending. Its
    // answer is newer than the batch status, so it replaces it: a workitem that started meanwhile
    // comes back inprogress, with no position.
    const pending = workitems.filter((w) => w.status === 'pending');
    for (let i = 0; i < pending.length; i += POSITION_BATCH_SIZE) {
        await Promise.all(pending.slice(i, i + POSITION_BATCH_SIZE).map(async (w) => {
            try {
                Object.assign(w, await daRequest(`${DA_BASE_URL}/workitems/${encodeURIComponent(w.id)}`, req.oauth_token));
            } catch (ex) {
                // One failed lookup must not cost the whole listing; the page shows that position as unknown.
                console.error(ex);
            }
        }));
    }

    // engine reads e.g. "Autodesk.Revit+2024" or "Autodesk.AutoCAD+24_3". It is the engine the
    // activity's alias points at now, which is the one the workitem ran on unless the alias moved since.
    const engines = new Map();
    await Promise.all([...new Set(workitems.map((w) => w.activityId).filter(Boolean))].map(async (id) => {
        try {
            engines.set(id, await activityEngine(id, req.oauth_token));
        } catch (ex) {
            // A deleted alias or another app's activity cannot be read; the page shows that engine as unknown.
            console.error(ex);
        }
    }));
    workitems.forEach((w) => { w.engine = engines.get(w.activityId) || null; });

    workitems = workitems
        .map((w) => Object.assign({ group: workitemGroup(w.status) }, w))
        .sort((a, b) => ((b.stats && b.stats.timeQueued) || '').localeCompare((a.stats && a.stats.timeQueued) || ''));
    res.status(200).json({
        requestedDays: days,
        coveredDays: lookback / (24 * 3600),
        workitems: workitems
    });
});

/// <summary>
/// Clear the accounts (for debugging purpouses)
/// </summary>
router.delete('/aps/designautomation/account', async /*ClearAccount*/(req, res) => {
    let api = await Utils.dav3API(req.apsEnv);
    // clear account
    await api.deleteForgeApp('me');
    res.status(200).end();
});

module.exports = router;