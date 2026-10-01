// Native sources outside ios/ that prebuild links in. Without them in the fingerprint, a change
// to the watch app alone would keep the runtime version, so no new TestFlight build would ship.
/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  extraSources: [{ type: "dir", filePath: "targets", reasons: ["@bacons/apple-targets"] }],
};
