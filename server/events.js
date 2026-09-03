/**
 * A tiny decoupling layer: game routes emit 'bet' events here after
 * resolving a bet, and index.js listens and broadcasts to connected
 * sockets. Avoids routes needing to require('../index') directly
 * (which would be circular, since index.js requires the routes).
 */
const { EventEmitter } = require('events');
module.exports = new EventEmitter();
