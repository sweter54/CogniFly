import { beforeAll, afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ConflictException, CreateScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { idZdarzenia, type Regula, type Zdarzenie } from '@cognifly/wspolne';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';
import { obsluzZdarzenie, type Zaleznosci } from '../../src/przetwarzanie/obsluz.js';
import { zapiszZdarzenie } from '../../src/dane/historia.js';
import { pobierzZadanie, utworzZadanie } from '../../src/dane/kolejka.js';
import { zapiszRegule, zapiszRole } from '../../src/dane/konfiguracja.js';

const tabela = ustawTabeleTestowa('cognifly-test-obsluz');
beforeAll(() => tabela.utworz());
afterAll(() => tabela.usun());

const sch = mockClient(SchedulerClient);
let licznik = 0;
const zd = (p: Partial<Zdarzenie> = {}): Zdarzenie => ({
  id: idZdarzenia('github', `obsluz-${++licznik}-${Math.random()}`),
  firma: 'f1', zrodlo: 'github', typ: 'github.pr.opened', czas: '2026-11-16T10:00:00.000Z',
  podmiot: { repo: 'app' }, opis: 'PR otwarty', wymagaPracy: true, ...p,
});
const reg = (p: Partial<Regula> = {}): Regula => ({
  id: 'r1', firma: 'f1', gdy: { zrodlo: 'github' }, powiadom: { osoby: ['ala'], kanaly: ['discord'] }, ...p,
});

const TERAZ = new Date('2026-11-16T10:00:00.000Z');
const wyslij = vi.fn();
let zal: Zaleznosci;

beforeEach(() => {
  sch.reset();
  sch.on(CreateScheduleCommand).resolves({});
  wyslij.mockReset();
  wyslij.mockResolvedValue({ wyslane: 1, bledy: [] });
  process.env.COGNIFLY_ESKALACJA_ARN = 'arn:aws:lambda:eu-central-1:167702900577:function:cognifly-test-eskalacja';
  process.env.COGNIFLY_SCHEDULER_ROLA_ARN = 'arn:aws:iam::167702900577:role/cognifly-test-scheduler';
  zal = { scheduler: new SchedulerClient({ region: 'eu-central-1' }), wyslijPowiadomienia: wyslij, teraz: () => TERAZ };
});

const wywolania = () => sch.commandCalls(CreateScheduleCommand).map((c) => c.args[0].input);

describe('obsluzZdarzenie', () => {
  test('budzik trafia do grupy z COGNIFLY_GRUPA_ESKALACJI (domyślnie default)', async () => {
    await zapiszRole('f-grp', 'dev', ['ola']);
    await zapiszRegule(reg({ id: 'g', firma: 'f-grp', przydziel: { role: ['dev'] } }));
    delete process.env.COGNIFLY_GRUPA_ESKALACJI;
    await obsluzZdarzenie(zd({ firma: 'f-grp' }), zal);
    expect(wywolania()[0]?.GroupName).toBe('default');
    sch.reset(); sch.on(CreateScheduleCommand).resolves({});
    process.env.COGNIFLY_GRUPA_ESKALACJI = 'cognifly-test-eskalacje';
    try {
      await obsluzZdarzenie(zd({ firma: 'f-grp' }), zal);
      expect(wywolania()[0]?.GroupName).toBe('cognifly-test-eskalacje');
    } finally { delete process.env.COGNIFLY_GRUPA_ESKALACJI; }
  });

  test('bez przydziału: tylko powiadomienia, bez zadania i budzika', async () => {
    await zapiszRegule(reg({ id: 'p1', firma: 'f-pow' }));
    const z = zd({ firma: 'f-pow' });
    const w = await obsluzZdarzenie(z, zal);
    expect(w).toEqual({ wynik: 'ZAPISANE' });
    expect(wywolania()).toHaveLength(0);
    expect(wyslij).toHaveBeenCalledWith('f-pow', z, [{ osoba: 'ala', kanaly: ['discord'] }], 'nowe');
  });

  test('z przydziałem: zadanie (opis, eskalujDo) + budzik +15 min w formacie at()', async () => {
    await zapiszRole('f-prz', 'dev', ['ola', 'ewa']);
    await zapiszRegule(reg({
      id: 'p', firma: 'f-prz', przydziel: { role: ['dev'] }, eskalujDo: { osoby: ['szef'], kanaly: ['email'] },
    }));
    const z = zd({ firma: 'f-prz', opis: 'Zrób przegląd' });
    const w = await obsluzZdarzenie(z, zal);
    expect(w.wynik).toBe('ZAPISANE');
    expect(w.zadanieId).toBe(`zad_${z.id.slice(4)}`);
    const zad = await pobierzZadanie('f-prz', w.zadanieId!);
    expect(zad).toMatchObject({
      zdarzenieId: z.id, kandydaci: ['ola', 'ewa'], opis: 'Zrób przegląd', stan: 'nowe',
      eskalujDo: [{ osoba: 'szef', kanaly: ['email'] }],
    });
    const [c] = wywolania();
    expect(wywolania()).toHaveLength(1);
    expect(c).toMatchObject({
      Name: `cognifly-test-esk-${w.zadanieId}`,
      ScheduleExpression: 'at(2026-11-16T10:15:00)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: {
        Arn: process.env.COGNIFLY_ESKALACJA_ARN,
        RoleArn: process.env.COGNIFLY_SCHEDULER_ROLA_ARN,
        Input: JSON.stringify({ firma: 'f-prz', zadanieId: w.zadanieId }),
      },
    });
    expect(wyslij).toHaveBeenCalledTimes(1);
  });

  test('eskalacjaMin per reguła wpływa na czas budzika', async () => {
    await zapiszRegule(reg({ id: 'm', firma: 'f-min', przydziel: { osoby: ['ola'] }, eskalacjaMin: 30 }));
    await obsluzZdarzenie(zd({ firma: 'f-min' }), zal);
    expect(wywolania()[0]?.ScheduleExpression).toBe('at(2026-11-16T10:30:00)');
  });

  test('duplikat bez zadania do utworzenia: nic nie robi', async () => {
    await zapiszRegule(reg({ id: 'd', firma: 'f-dup' }));
    const z = zd({ firma: 'f-dup' });
    await obsluzZdarzenie(z, zal);
    wyslij.mockClear();
    expect(await obsluzZdarzenie(z, zal)).toEqual({ wynik: 'DUPLIKAT' });
    expect(wyslij).not.toHaveBeenCalled();
    expect(wywolania()).toHaveLength(0);
  });

  test('duplikat po pełnym przetworzeniu: zadanie bez zmian, budzik = Conflict (OK), bez powiadomień', async () => {
    await zapiszRegule(reg({ id: 'd2', firma: 'f-dup2', przydziel: { osoby: ['ola'] } }));
    const z = zd({ firma: 'f-dup2' });
    const p = await obsluzZdarzenie(z, zal);
    sch.reset(); wyslij.mockClear();
    sch.on(CreateScheduleCommand).rejects(new ConflictException({ message: 'exists', Message: 'exists', $metadata: {} }));
    const przed = await pobierzZadanie('f-dup2', p.zadanieId!);
    const w = await obsluzZdarzenie(z, zal);
    expect(w).toEqual({ wynik: 'DUPLIKAT', zadanieId: p.zadanieId });
    expect(await pobierzZadanie('f-dup2', p.zadanieId!)).toEqual(przed);
    expect(wyslij).not.toHaveBeenCalled();
  });

  test('retry po częściowej awarii: zapis był, zadania brak -> zadanie + budzik, bez powiadomień', async () => {
    await zapiszRegule(reg({ id: 'r', firma: 'f-ret', przydziel: { osoby: ['ola'] } }));
    const z = zd({ firma: 'f-ret' });
    expect(await zapiszZdarzenie(z)).toBe('NOWE');
    const w = await obsluzZdarzenie(z, zal);
    expect(w.wynik).toBe('DUPLIKAT');
    expect(w.zadanieId).toBeDefined();
    expect(await pobierzZadanie('f-ret', w.zadanieId!)).not.toBeNull();
    expect(wywolania()).toHaveLength(1);
    expect(wywolania()[0]?.ScheduleExpression).toBe('at(2026-11-16T10:15:00)');
    expect(wyslij).not.toHaveBeenCalled();
  });

  test('retry: zadanie jest, budzika brak (stan nowe) -> budzik domknięty od utworzono, min. +60 s', async () => {
    await zapiszRegule(reg({ id: 'r', firma: 'f-ret2', przydziel: { osoby: ['ola'] } }));
    const z = zd({ firma: 'f-ret2' });
    await zapiszZdarzenie(z);
    await utworzZadanie('f-ret2', z.id, ['ola'], { opis: z.opis, id: `zad_${z.id.slice(4)}` });
    const w = await obsluzZdarzenie(z, zal);
    expect(w.wynik).toBe('DUPLIKAT');
    expect(wywolania()).toHaveLength(1);
    const zad = await pobierzZadanie('f-ret2', w.zadanieId!);
    const oczekiwany = new Date(Math.max(Date.parse(zad!.utworzono) + 15 * 60_000, TERAZ.getTime() + 60_000));
    expect(wywolania()[0]?.ScheduleExpression).toBe(`at(${oczekiwany.toISOString().slice(0, 19)})`);
    expect(wyslij).not.toHaveBeenCalled();
  });

  test('ConflictException przy budziku = sukces', async () => {
    sch.on(CreateScheduleCommand).rejects(new ConflictException({ message: 'exists', Message: 'exists', $metadata: {} }));
    await zapiszRegule(reg({ id: 'c', firma: 'f-con', przydziel: { osoby: ['ola'] } }));
    const w = await obsluzZdarzenie(zd({ firma: 'f-con' }), zal);
    expect(w.wynik).toBe('ZAPISANE');
    expect(wyslij).toHaveBeenCalledTimes(1);
  });

  test('inny błąd Schedulera rzuca (EventBridge ponowi)', async () => {
    sch.on(CreateScheduleCommand).rejects(new Error('throttled'));
    await zapiszRegule(reg({ id: 's', firma: 'f-err', przydziel: { osoby: ['ola'] } }));
    await expect(obsluzZdarzenie(zd({ firma: 'f-err' }), zal)).rejects.toThrow('throttled');
    expect(wyslij).not.toHaveBeenCalled();
  });

  test('błąd powiadomień (bledy lub wyjątek) nie przewraca zdarzenia', async () => {
    await zapiszRegule(reg({ id: 'n', firma: 'f-nb' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    wyslij.mockResolvedValueOnce({ wyslane: 0, bledy: ['smtp'] });
    expect((await obsluzZdarzenie(zd({ firma: 'f-nb' }), zal)).wynik).toBe('ZAPISANE');
    wyslij.mockRejectedValueOnce(new Error('boom'));
    expect((await obsluzZdarzenie(zd({ firma: 'f-nb' }), zal)).wynik).toBe('ZAPISANE');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
