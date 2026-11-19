import { describe, expect, it } from 'vitest';
import { callWhenReady, rpcClient, rpcServer, RpcError } from '../src/logic/rpc.js';
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

  it('callWhenReady retries until the background window starts serving', async () => {
    const b = bus();
    const call = await rpcClient(b('main'), 'main');
    setTimeout(() => void rpcServer(b('background'), { 'inbox.get': async () => ({ ok: 1 }) }, () => 'X'), 30);
    expect(await callWhenReady(call, 'inbox.get', {}, { attemptMs: 10, totalMs: 1000 })).toEqual({ ok: 1 });
  });

  it('callWhenReady gives up with TIMEOUT after totalMs', async () => {
    const call = await rpcClient(bus()('main'), 'main');
    await expect(callWhenReady(call, 'inbox.get', {}, { attemptMs: 10, totalMs: 40 })).rejects.toEqual(new RpcError('TIMEOUT'));
  });

  it('callWhenReady does not retry a server error', async () => {
    const b = bus();
    let n = 0;
    await rpcServer(b('background'), { boom: async () => { n += 1; throw new Error('x'); } }, () => 'UNEXPECTED');
    const call = await rpcClient(b('main'), 'main');
    await expect(callWhenReady(call, 'boom', {}, { attemptMs: 50, totalMs: 500 })).rejects.toEqual(new RpcError('UNEXPECTED'));
    expect(n).toBe(1);
  });
});
