import { describe, expect, it } from 'vitest';
import { rpcClient, rpcServer, RpcError, type Bus } from '../src/logic/rpc.js';

/** In-memory bus: routes events by target window label. */
function bus() {
  const listeners = new Map<string, Map<string, ((p: unknown) => void)[]>>();
  const forWindow = (label: string): Bus => ({
    async emitTo(target, event, payload) {
      for (const h of listeners.get(target)?.get(event) ?? []) h(structuredClone(payload));
    },
    async listen(event, handler) {
      const byEvent = listeners.get(label) ?? new Map();
      listeners.set(label, byEvent);
      byEvent.set(event, [...(byEvent.get(event) ?? []), handler]);
      return () => undefined;
    },
  });
  return forWindow;
}

describe('rpc', () => {
  it('routes a call to the background handler and back', async () => {
    const b = bus();
    await rpcServer(b('background'), { 'inbox.list': async (p) => ({ echo: p }) }, () => 'X');
    const call = await rpcClient(b('inbox'), 'inbox');
    expect(await call('inbox.list', { a: 1 })).toEqual({ echo: { a: 1 } });
  });

  it('returns only the mapped error code', async () => {
    const b = bus();
    await rpcServer(b('background'), { boom: async () => { throw new Error('secret token abc'); } }, () => 'UNEXPECTED');
    const call = await rpcClient(b('login'), 'login');
    await expect(call('boom')).rejects.toEqual(new RpcError('UNEXPECTED'));
  });

  it('rejects unknown and prototype methods', async () => {
    const b = bus();
    await rpcServer(b('background'), {}, () => 'X');
    const call = await rpcClient(b('inbox'), 'inbox');
    await expect(call('toString')).rejects.toEqual(new RpcError('UNKNOWN_METHOD'));
  });

  it('times out without a server', async () => {
    const call = await rpcClient(bus()('inbox'), 'inbox', 10);
    await expect(call('x')).rejects.toEqual(new RpcError('TIMEOUT'));
  });
});
