process.env.VERIFY_OVERLOADED_MESSAGE = `Overloaded. ${'The upstream gateway returned a long diagnostic body. '.repeat(100)}`;
await import('./mock-api-overloaded.ts');
