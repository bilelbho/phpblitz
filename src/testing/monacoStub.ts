// Monaco for unit tests: every property and call returns the stub itself, so modules that
// register providers or read Monaco's API when they load work in Node. Tests check pure functions.
const handler: ProxyHandler<object> = {
  get: (_target, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
};
const stub: any = new Proxy(function stub() {}, handler);

export const languages = stub;
export const editor = stub;
export const Uri = stub;
export const Range = stub;
export const Selection = stub;
export const MarkerSeverity = stub;
export const Emitter = stub;
export const KeyCode = stub;
export const KeyMod = stub;
export default stub;
