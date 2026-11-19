import { describe, expect, it, vi } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import type { Task } from '@cognifly/wspolne/api';
import { IntError, type IntClient } from '../../src/heartwood/klient.js';
import { changedWork, handleStream } from '../../src/heartwood/strumien.js';

const ID = 'zad_0123456789ab';
const task = (p: Partial<Task>): Task => ({
  id: ID, firma: 'pilot', zdarzenieId: 'z', kandydaci: [],
  stan: 'nowe', utworzono: '2026-01-01T00:00:00Z', opis: 'o', ...p,
});
const item = (t: Task) => ({ pk: `FIRMA#${t.firma}#ZAD`, sk: t.id, ...t });
const rec = (o: Task | undefined, n: Task | undefined, pk = 'FIRMA#pilot#ZAD', eventID = 'e1') => ({
  eventID,
  dynamodb: {
    ...(o ? { OldImage: marshall({ ...item(o), pk }, { removeUndefinedValues: true }) } : {}),
    ...(n ? { NewImage: marshall({ ...item(n), pk }, { removeUndefinedValues: true }) } : {}),
  },
});
const ev = (...r: ReturnType<typeof rec>[]) => ({ Records: r }) as unknown as DynamoDBStreamEvent;

const setup = (subs: Record<string, string> = { michal: 'sub-m', szymon: 'sub-s' }) => {
  const putWork = vi.fn<IntClient['putWork']>().mockResolvedValue();
  const log = vi.fn();
  const deps = {
    client: { putWork } as unknown as IntClient,
    subOf: async (_f: string, o: string) => subs[o] ?? null,
    log,
  };
  return { putWork, log, deps };
};

describe('changedWork', () => {
  it('is null without change or without new image', () => {
    const t = task({ stan: 'wziete', wlasciciel: 'michal' });
    expect(changedWork(t, task({ stan: 'w_trakcie', wlasciciel: 'michal' }))).toBeNull();
    expect(changedWork(t, undefined)).toBeNull();
    expect(changedWork(undefined, task({}))).toBeNull();
  });
  it('return to new clears the writer of an open work', () => {
    expect(changedWork(task({ stan: 'w_trakcie', wlasciciel: 'michal' }), task({})))
      .toEqual({ writer: null, closed: false });
    expect(changedWork(task({ stan: 'do_akceptacji', akceptujacy: 'szymon' }),
      task({ stan: 'eskalowane' }))).toEqual({ writer: null, closed: false });
  });
  it('closed work back to new is a no-op', () => {
    expect(changedWork(task({ stan: 'odrzucone' }), task({}))).toBeNull();
    expect(changedWork(task({ stan: 'do_akceptacji' }), task({}))).toBeNull();
  });
  it('returns the new state on change', () => {
    expect(changedWork(task({}), task({ stan: 'wziete', wlasciciel: 'michal' })))
      .toEqual({ writer: 'michal', closed: false });
  });
});

describe('handleStream', () => {
  it('state change sends writer', async () => {
    const { putWork, deps } = setup();
    const r = await handleStream(ev(rec(task({}), task({ stan: 'wziete', wlasciciel: 'michal' }))), deps);
    expect(r).toEqual({ batchItemFailures: [] });
    expect(putWork).toHaveBeenCalledWith('pilot', `cognifly:${ID}`, { writer: 'sub-m', closed: false });
  });
  it('same work state sends nothing', async () => {
    const { putWork, deps } = setup();
    await handleStream(ev(rec(task({ stan: 'wziete', wlasciciel: 'michal' }),
      task({ stan: 'w_trakcie', wlasciciel: 'michal' }))), deps);
    expect(putWork).not.toHaveBeenCalled();
  });
  it('handover changes writer without state change', async () => {
    const { putWork, deps } = setup();
    await handleStream(ev(rec(task({ stan: 'w_trakcie', wlasciciel: 'michal' }),
      task({ stan: 'w_trakcie', wlasciciel: 'szymon' }))), deps);
    expect(putWork).toHaveBeenCalledWith('pilot', `cognifly:${ID}`, { writer: 'sub-s', closed: false });
  });
  it('handover via new clears the writer', async () => {
    const { putWork, deps } = setup();
    await handleStream(ev(rec(task({ stan: 'w_trakcie', wlasciciel: 'michal' }),
      task({ stan: 'nowe' }))), deps);
    expect(putWork).toHaveBeenCalledWith('pilot', `cognifly:${ID}`, { writer: null, closed: false });
  });
  it('closed back to new sends nothing', async () => {
    const { putWork, deps } = setup();
    await handleStream(ev(rec(task({ stan: 'odrzucone' }), task({ stan: 'nowe' }))), deps);
    expect(putWork).not.toHaveBeenCalled();
  });
  it('acceptance without acceptor gives null writer', async () => {
    const { putWork, log, deps } = setup();
    await handleStream(ev(rec(task({ stan: 'w_trakcie', wlasciciel: 'michal' }),
      task({ stan: 'do_akceptacji', wlasciciel: 'michal' }))), deps);
    expect(putWork).toHaveBeenCalledWith('pilot', `cognifly:${ID}`, { writer: null, closed: false });
    expect(log).not.toHaveBeenCalled();
  });
  it('done closes work', async () => {
    const { putWork, deps } = setup();
    await handleStream(ev(rec(task({ stan: 'do_akceptacji', akceptujacy: 'szymon' }),
      task({ stan: 'zrobione', akceptujacy: 'szymon' }))), deps);
    expect(putWork).toHaveBeenCalledWith('pilot', `cognifly:${ID}`, { writer: null, closed: true });
  });
  it('unknown sub maps to null writer', async () => {
    const { putWork, log, deps } = setup({});
    const r = await handleStream(ev(rec(task({}), task({ stan: 'wziete', wlasciciel: 'michal' }))), deps);
    expect(putWork).toHaveBeenCalledWith('pilot', `cognifly:${ID}`, { writer: null, closed: false });
    expect(r.batchItemFailures).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });
  it('client error reports batch item failure', async () => {
    const { putWork, deps } = setup();
    putWork.mockRejectedValue(new IntError(503, 'UNAVAILABLE'));
    const r = await handleStream(ev(rec(task({}), task({ stan: 'wziete', wlasciciel: 'michal' }), 'FIRMA#pilot#ZAD', 'ev-9')), deps);
    expect(r).toEqual({ batchItemFailures: [{ itemIdentifier: 'ev-9' }] });
  });
  it('ignores non-task records', async () => {
    const { putWork, deps } = setup();
    await handleStream(ev(rec(task({}), task({ stan: 'wziete', wlasciciel: 'michal' }), 'FIRMA#pilot#SKR#michal')), deps);
    expect(putWork).not.toHaveBeenCalled();
  });
  it('removed record sends nothing', async () => {
    const { putWork, deps } = setup();
    await handleStream(ev(rec(task({ stan: 'wziete', wlasciciel: 'michal' }), undefined)), deps);
    expect(putWork).not.toHaveBeenCalled();
  });
});
