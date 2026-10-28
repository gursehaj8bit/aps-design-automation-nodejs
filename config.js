// Autodesk Forge configuration
module.exports = {
    // Set environment variables or hard-code here. The app the command-line scripts (npm run
    // publish:*, family:svf) work on; the page uses it only as dev's stand-in, below.
    credentials: {
        client_id: process.env.APS_CLIENT_ID,
        client_secret: process.env.APS_CLIENT_SECRET,
        callback_url: process.env.APS_CALLBACK || process.env.APS_CALLBACK_URL,
        webhook_url: process.env.APS_WEBHOOK_URL
    },
    // The page's environments, each its own APS app with its own APS_<ENV>_CLIENT_ID and
    // APS_<ENV>_CLIENT_SECRET. A change to a guarded one needs its name typed to confirm.
    environments: ['dev', 'testing', 'uat', 'prod'].map((name) => {
        const variables = [`APS_${name.toUpperCase()}_CLIENT_ID`, `APS_${name.toUpperCase()}_CLIENT_SECRET`];
        const [client_id, client_secret] = variables.map((v) => process.env[v]);
        // Until dev has its own app it borrows the pair above, but only when neither of its own is
        // set: a half-set pair stays unconfigured rather than mixing one app's id with another's secret.
        const borrowed = name === 'dev' && !client_id && !client_secret;
        return ({
            name: name,
            client_id: borrowed ? process.env.APS_CLIENT_ID : client_id,
            client_secret: borrowed ? process.env.APS_CLIENT_SECRET : client_secret,
            borrowed: borrowed,
            missing: variables.filter((v) => !process.env[v]),
            guarded: name === 'prod'
        });
    }),
    scopes: {
        // Required scopes for the server-side application
        internal: ['bucket:create', 'bucket:read', 'bucket:delete', 'data:read', 'data:create', 'data:write', 'code:all'],
        // Required scope for the client-side viewer
        public: ['viewables:read']
    },
    client: {
        circuitBreaker: {
            threshold: 11,
            interval: 1200
        },
        retry: {
            maxNumberOfRetries: 7,
            backoffDelay: 4000,
            backoffPolicy: 'exponentialBackoffWithJitter'
        },
        requestTimeout: 13000
    }
};
