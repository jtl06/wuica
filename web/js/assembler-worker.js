// The worker that runs the assembler (see assembler-rpc.js). Started as a module worker by app.js.
import { createAssemblerHandler } from './assembler-rpc.js';

const handle = createAssemblerHandler();
self.onmessage = async (ev) => self.postMessage(await handle(ev.data));
