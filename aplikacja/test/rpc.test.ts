import { describe, expect, it } from 'vitest';
import { rpcClient, rpcServer, RpcError } from '../src/logic/rpc.js';
import { memoryBus as bus } from './helpers.js';

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

  it('carries a detail text only when toDetail gives one', async () => {
    const b = bus();
    const detail = (e: unknown) => (e instanceof Error && e.message === 'refused' ? 'Plik blokuje Ania.' : undefined);
    await rpcServer(b('background'), { refused: async () => { throw new Error('refused'); }, boom: async () => { throw new Error('x'); } }, () => 'LOCKED', detail);
    const call = await rpcClient(b('main'), 'main');
    const err = await call('refused').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: 'LOCKED', detail: 'Plik blokuje Ania.' });
    expect(await call('boom').catch((e: unknown) => e)).toMatchObject({ code: 'LOCKED', detail: undefined });
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

  it('honours a per-call wait longer than the default', async () => {
    const b = bus();
    await rpcServer(b('background'), { slow: () => new Promise((r) => setTimeout(() => r('ok'), 30)) }, () => 'X');
    const call = await rpcClient(b('main'), 'main', 10);
    await expect(call('slow')).rejects.toEqual(new RpcError('TIMEOUT'));
    expect(await call('slow', {}, 200)).toBe('ok');
  });
});
