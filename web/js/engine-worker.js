// The worker that runs the analyzer (see engine-rpc.js). Started as a module worker by app.js.
import { createHandler, inParts } from './engine-rpc.js';

const handle = createHandler();
// a large answer goes in parts (engine-rpc.js inParts): each message is read by the page in a task of its own
self.onmessage = async (ev) => { for (const m of inParts(await handle(ev.data))) self.postMessage(m); };
