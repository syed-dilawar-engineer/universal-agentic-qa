#!/usr/bin/env node
import { runCli } from '../dist/index.js';

runCli(process.argv)
  .then((exitCode) => {
    if (typeof exitCode === 'number' && exitCode !== 0) {
      process.exit(exitCode);
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
