import module from 'node:module';

const isBuiltin = module.isBuiltin;
module.isBuiltin = (specifier: string) =>
  specifier !== 'ws' && specifier !== 'undici' && isBuiltin(specifier);
