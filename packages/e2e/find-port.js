#!/usr/bin/env node
/**
 * Find an available port for E2E tests
 * Prevents conflicts when multiple test sessions run concurrently
 */

const net = require('net');

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => {
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

findAvailablePort()
  .then((port) => {
    console.log(port);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Failed to find available port:', err);
    process.exit(1);
  });
