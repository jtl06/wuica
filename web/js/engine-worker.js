// The worker that runs the analyzer (see engine-rpc.js). Started as a module worker by app.js.
import { createHandler } from './engine-rpc.js';

const handle = createHandler();
self.onmessage = async (ev) => self.postMessage(await handle(ev.data));
