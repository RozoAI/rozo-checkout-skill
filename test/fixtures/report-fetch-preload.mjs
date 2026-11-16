// Test-only preload (never shipped: test/ is not in the npm tarball). The CLI
// pins its report URL with no runtime override, so the end-to-end tests
// redirect that one URL to a local sink here, standing in for an injected fetch.
const SINK = process.env.TEST_REPORT_SINK;
const PINNED = 'https://apiserver.mpprouter.dev/v1/checkout/client-report';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (String(url) === PINNED) {
    if (!SINK) return Promise.reject(new Error('report sink not set'));
    return realFetch(SINK, init);
  }
  return realFetch(url, init);
};
