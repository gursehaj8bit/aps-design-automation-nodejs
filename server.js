const _path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('./config');
// The page works on the environments' apps; APS_CLIENT_ID's app counts only as dev's stand-in.
if (!config.environments.some((e) => e.client_id && e.client_secret))
    return (console.error('No APS environment configured. Set APS_<ENV>_CLIENT_ID and APS_<ENV>_CLIENT_SECRET for at least one of '
        + config.environments.map((e) => e.name.toUpperCase()).join(', ') + '.'));

let app = express();
app.use(express.static(_path.join(__dirname, './public')));
app.use(cookieSession({
    name: 'aps_session',
    keys: ['aps_secure_key'],
    maxAge: 60 * 60 * 1000 // 1 hour, same as the 2 legged lifespan token
}));
app.use(express.json({
    limit: '50mb'
}));
// Mounted first: the Design Automation router fetches an APS token for every /api request it sees.
app.use('/api', require('./routes/BlobStorage'));
app.use('/api', require('./routes/Addins'));
app.use('/api', require('./routes/DesignAutomation'));

app.set('port', process.env.PORT || 8080);

module.exports = app;
