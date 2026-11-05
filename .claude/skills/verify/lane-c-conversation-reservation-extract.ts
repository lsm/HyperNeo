process.argv.splice(-1, 0, '--conversation-reservation');
await import('./lane-c-human-reset-command.ts');
