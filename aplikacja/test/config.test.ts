import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveChoices, validateConfig } from '../src/logic/config.js';
import { memoryStore } from '../src/logic/storage.js';

describe('config', () => {
  it('defaults to the pilot stack', () => {
    expect(loadConfig(memoryStore())).toEqual({
      apiUrl: 'https://td5k44easl.execute-api.eu-central-1.amazonaws.com',
      clientId: '67b7re8ou041svoosk3ukotqrq',
      region: 'eu-central-1',
      company: 'pilot',
      workFolder: '',
      heartwoodUrl: 'https://eohqtq0t3j.execute-api.eu-central-1.amazonaws.com',
      heartwoodWsUrl: 'wss://s0ulscfugh.execute-api.eu-central-1.amazonaws.com/prod',
    });
  });

  it('accepts an absolute work folder and strips its trailing slash', () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, workFolder: ' /Users/m/repo/ ' })).toEqual({ ok: true, config: { ...DEFAULT_CONFIG, workFolder: '/Users/m/repo' } });
  });

  it('accepts empty Heartwood addresses (files disabled) and wss for the socket', () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, heartwoodUrl: '', heartwoodWsUrl: '' }).ok).toBe(true);
    const r = validateConfig({ ...DEFAULT_CONFIG, heartwoodUrl: 'https://hw.example.com/', heartwoodWsUrl: 'wss://ws.example.com' });
    expect(r).toEqual({ ok: true, config: { ...DEFAULT_CONFIG, heartwoodUrl: 'https://hw.example.com', heartwoodWsUrl: 'wss://ws.example.com' } });
  });

  it('trims values and strips trailing slashes', () => {
    const r = validateConfig({ ...DEFAULT_CONFIG, apiUrl: ' https://a.example.com/// ', company: ' pilot ' });
    expect(r).toEqual({ ok: true, config: { ...DEFAULT_CONFIG, apiUrl: 'https://a.example.com' } });
  });

  it.each([
    ['apiUrl', 'http://insecure.example.com'],
    ['apiUrl', 'https://user:pw@a.example.com'],
    ['apiUrl', 'https://a.example.com/?q=1'],
    ['heartwoodUrl', 'http://hw.example.com'],
    ['heartwoodWsUrl', 'ws://hw.example.com'],
    ['clientId', 'abc-def'],
    ['region', 'Frankfurt'],
    ['company', 'Pilot!'],
    ['workFolder', 'repo/wzgledny'],
    ['workFolder', '/Users/m/../etc'],
    ['workFolder', '/Users/m/\u0007'],
  ])('rejects bad %s %s', (field, value) => {
    expect(validateConfig({ ...DEFAULT_CONFIG, [field]: value })).toEqual({ ok: false, field });
  });

  it('stores only the user choices; connection always comes from the build', () => {
    const store = memoryStore();
    expect(saveChoices(store, { company: 'Zla!', workFolder: '' }).ok).toBe(false);
    expect(loadConfig(store)).toEqual(DEFAULT_CONFIG);
    saveChoices(store, { company: 'inna', workFolder: '/Users/m/repo' });
    expect(JSON.parse(store.getItem('cognifly.config')!)).toEqual({ company: 'inna', workFolder: '/Users/m/repo' });
    expect(loadConfig(store)).toEqual({ ...DEFAULT_CONFIG, company: 'inna', workFolder: '/Users/m/repo' });
  });

  it('ignores connection values stored by older versions', () => {
    const store = memoryStore();
    store.setItem('cognifly.config', JSON.stringify({ apiUrl: 'https://evil.example.com', region: 'us-east-1', company: 'pilot', workFolder: '/Users/m' }));
    expect(loadConfig(store)).toEqual({ ...DEFAULT_CONFIG, workFolder: '/Users/m' });
  });

  it('ignores corrupt stored data', () => {
    const store = memoryStore();
    store.setItem('cognifly.config', '{not json');
    expect(loadConfig(store)).toEqual(DEFAULT_CONFIG);
  });
});
