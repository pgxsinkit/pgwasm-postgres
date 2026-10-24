// pre.js (postgres.js only): the filesystem bundle, postgres.data, is in place before any of the host's preRun callbacks
// runs, as up to Emscripten 3.1.74.
//
// emcc puts the file packager's code (--preload-file) ahead of every --pre-js, and that code appends its loader to
// Module.preRun, after the callbacks the host passed. Emscripten 4.0.7 runs Module.preRun in the order listed; 3.1.74
// ran it in reverse, so the loader, listed last, ran first. Moving it to the front keeps that: a host's preRun
// callbacks see the bundle's files (to chmod them, or to mount storage under /pgwasm), and run after it in the order
// they are listed. With getPreloadedPackage, the loader creates the files synchronously.
Module['preRun'].unshift(Module['preRun'].pop());

// Emscripten 6.0.13 no longer publishes FS.filesystems. Keep the interface used by
// pgxsinkit's file and IndexedDB mounts available before any host preRun callback.
Module['preRun'].unshift(function () {
  var fs = Module['FS'];
  var types = fs['filesystems'] || (fs['filesystems'] = {});
  types['MEMFS'] = Module['MEMFS'];
  types['IDBFS'] = Module['IDBFS'];
  types['NODEFS'] = Module['NODEFS'];
  types['PROXYFS'] = Module['PROXYFS'];
});
