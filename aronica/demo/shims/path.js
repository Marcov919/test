const norm = (p) => {
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return (p.startsWith('/') ? '/' : '') + out.join('/');
};
export const join = (...p) => norm(p.filter(Boolean).join('/'));
export const resolve = (...p) => norm('/' + p.filter(Boolean).join('/'));
export const normalize = norm;
export const dirname = (p) => p.split('/').slice(0, -1).join('/') || '/';
export const extname = (p) => { const m = /\.[^./]*$/.exec(p); return m ? m[0] : ''; };
export default { join, resolve, normalize, dirname, extname };
