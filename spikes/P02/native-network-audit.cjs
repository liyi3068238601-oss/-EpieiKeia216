const http = require('node:http');
const original = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address();
    console.log('P02_NATIVE_LISTENER ' + JSON.stringify({ requested: args.filter(value => typeof value !== 'function'), address }));
  });
  return original.apply(this, args);
};
