import type { FromGrowth, ToGrowth } from './growthProtocol';
import { GrowthRun } from './growthRun';

/** THE CITY'S GROWTH OFF THE PAGE: its own copy of the document, grown a batch at a time as the page asks (`growthHost.ts`) */

const run = new GrowthRun();

self.onmessage = (event: MessageEvent<ToGrowth>) => {
  const m = event.data;
  let reply: FromGrowth | null;
  try {
    reply = m.kind === 'grow' ? run.start(m) : run.heights(m);
  } catch (error) {
    // Told and answered: the page grows the city itself from here on (`growthHost.ts`).
    console.error('[growth] a batch failed in its worker', error);
    reply = { kind: 'failed', seq: m.seq, error: String(error) };
  }
  if (reply) self.postMessage(reply);
};
