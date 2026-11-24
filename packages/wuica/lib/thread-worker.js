// A worker thread of the library's thread pool (threads.js): an analyzer instance of the shared compiled module (whose
// memory has a smaller limit than the main thread's), with the tables of the microarchitectures it is given. It answers
// one job at a time with the fields of a compare() row. Nothing in here writes to stdout (the MCP server speaks JSON-RPC
// on stdout).
//
// workerData: {module (WebAssembly.Module), uarch (bytes of uarch.json), dataDir, recycleBytes}
// Messages in: {id, table, request, full}
// Messages out: {type: 'ready'} | {type: 'init-error', message} | {id, fields, recycle}
//   fields: a compare() row's fields, or with `full` the whole analysis result (analyzeMany).
//   fields null: the table could not be loaded, or the analysis trapped (it may only have hit this thread's memory
//   limit): the main thread does it again, so that the row is the one it would have made itself.
//   recycle: this thread should be stopped (its memory, which never shrinks, has grown beyond recycleBytes, or it trapped).

import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { Analyzer } from './wasm.js';
import { readMaybeCompressed, readMaybeCompressedSync, tableFile } from './files.js';
import { analysisResult, compareFields } from './core.js';

if (!parentPort) throw new Error('thread-worker.js runs as a worker thread');
const port = parentPort;
const { module, uarch, dataDir, recycleBytes } = workerData;
/** @type {Analyzer | null} */
let analyzer = null;
try {
  analyzer = new Analyzer(module);
  analyzer.loadUarch(uarch);
} catch (e) {
  port.postMessage({ type: 'init-error', message: String(e?.message ?? e) });
}

if (analyzer) {
  port.on('message', async ({ id, table, request, full }) => {
    if (!analyzer.hasArch(table)) {
      try {
        const file = tableFile(dataDir, table);
        analyzer.loadArch(table, await readMaybeCompressed(file), () => readMaybeCompressedSync(file));
      } catch {
        port.postMessage({ id, fields: null, recycle: analyzer.memoryBytes === 0 }); // 0: the module trapped
        return;
      }
    }
    const response = analyzer.analyze(request);
    if (response.trapped || analyzer.memoryBytes === 0) { // trapped, or could not be restarted after an earlier trap
      port.postMessage({ id, fields: null, recycle: true });
      return;
    }
    const result = analysisResult(response);
    port.postMessage({ id, fields: full ? result : compareFields(result), recycle: analyzer.memoryBytes > recycleBytes });
  });
  port.postMessage({ type: 'ready' });
}
