// Preloaded by the Docker image before `next start`. Node closes any request that lasts more than
// 5 minutes (server.requestTimeout), which cuts large video uploads on a slow connection; Next.js
// does not expose this setting, so the HTTP servers it creates get a longer limit here.
const http = require('node:http');

const REQUEST_TIMEOUT_MS = Number(process.env.SERVER_REQUEST_TIMEOUT_MS) || 60 * 60 * 1000;
const createServer = http.createServer;

http.createServer = function createServerWithUploadTimeout(...args) {
    const server = createServer.apply(this, args);
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    return server;
};
