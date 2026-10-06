const { AuthClientTwoLegged } = require('forge-apis');
const config = require('../../config');

// Clients are cached per scope set. forge-apis stores its autoRefresh flag but never acts on it,
// so getClient re-authenticates a cached client itself once its token is near expiry.
let cache = {};
let refreshing = {};
const REFRESH_MARGIN_SECONDS = 300;

// Since we got 3 calls at the first page loading, let's initialize this one now,
// to avoid concurrent requests.
getClient (/*config.scopes.internal*/);

/**
 * Initializes a Forge client for 2-legged authentication.
 * @param {string[]} scopes List of resource access scopes.
 * @returns {AuthClientTwoLegged} 2-legged authentication client.
 */
async function getClient(scopes) {
    scopes = scopes || config.scopes.internal;
    const key = scopes.join('+');
    if ( cache[key] ) {
        const client = cache[key];
        if ( !client.isAboutToExpire(REFRESH_MARGIN_SECONDS) )
            return (client);
        // Concurrent requests share one re-authentication rather than each fetching a token.
        refreshing[key] = refreshing[key] || client.authenticate()
            .then(() => console.log(`OAuth2 token refreshed for ${key}`))
            .catch((ex) => console.error(`OAuth2 token refresh failed for ${key}`, ex))
            .finally(() => delete refreshing[key]);
        await refreshing[key];
        return (client);
    }

    try {
        const { client_id, client_secret } = config.credentials;
        let client = new AuthClientTwoLegged(client_id, client_secret, scopes || config.scopes.internal, true);
        let credentials = await client.authenticate();
        cache[key] = client;
        console.log (`OAuth2 client created for ${key}`);
        return (client);
    } catch ( ex ) {
        return (null);
    }
}

module.exports = {
    getClient
};
