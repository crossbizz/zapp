const target = Math.random() > 0.5 ? 'node:fs' : process.env.PROVIDER_TARGET;

require(target);
