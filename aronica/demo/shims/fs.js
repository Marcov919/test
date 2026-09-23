const nope = () => { throw Object.assign(new Error('no filesystem in the browser demo'), { code: 'ENOENT' }); };
export const mkdirSync = () => {};
export const writeFileSync = () => {};
export const rmSync = () => {};
export const mkdtempSync = () => '/tmp';
export const readFile = async () => nope();
export const stat = async () => nope();
export default { mkdirSync, writeFileSync, rmSync, mkdtempSync };
