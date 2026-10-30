#!/usr/bin/env node
import('../dist/cli.js').catch((error) => {
  process.stderr.write(`sfci could not start: ${error.message}\n`);
  process.exitCode = 1;
});
