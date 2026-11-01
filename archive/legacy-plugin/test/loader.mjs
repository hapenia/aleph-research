const stubs = new Map([
  ['@deepseek-ai/dsh-storage-domain', new URL('./stubs/storage-domain.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-tools', new URL('./stubs/dsh-tools.mjs', import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
  if (stubs.has(specifier)) return { url: stubs.get(specifier), shortCircuit: true };
  return nextResolve(specifier, context);
}
