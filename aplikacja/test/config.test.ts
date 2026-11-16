import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig, validateConfig } from '../src/logic/config.js';
import { memoryStore } from '../src/logic/storage.js';

describe('config', () => {
  it('defaults to the pilot stack', () => {
    expect(loadConfig(memoryStore())).toEqual({
      apiUrl: 'https://td5k44easl.execute-api.eu-central-1.amazonaws.com',
      clientId: '67b7re8ou041svoosk3ukotqrq',
      region: 'eu-central-1',
      company: 'pilot',
      workFolder: '',
    });
  });

  it('accepts an absolute work folder and strips its trailing slash', () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, workFolder: ' /Users/m/repo/ ' })).toEqual({ ok: true, config: { ...DEFAULT_CONFIG, workFolder: '/Users/m/repo' } });
  });

  it('trims values and strips trailing slashes', () => {
    const r = validateConfig({ ...DEFAULT_CONFIG, apiUrl: ' https://a.example.com/// ', company: ' pilot ' });
    expect(r).toEqual({ ok: true, config: { ...DEFAULT_CONFIG, apiUrl: 'https://a.example.com' } });
  });

  it.each([
    ['apiUrl', 'http://insecure.example.com'],
    ['apiUrl', 'https://user:pw@a.example.com'],
    ['apiUrl', 'https://a.example.com/?q=1'],
    ['clientId', 'abc-def'],
    ['region', 'Frankfurt'],
    ['company', 'Pilot!'],
    ['workFolder', 'repo/wzgledny'],
    ['workFolder', '/Users/m/../etc'],
    ['workFolder', '/Users/m/\u0007'],
  ])('rejects bad %s %s', (field, value) => {
    expect(validateConfig({ ...DEFAULT_CONFIG, [field]: value })).toEqual({ ok: false, field });
  });

  it('saves only valid settings and loads them back', () => {
    const store = memoryStore();
    expect(saveConfig(store, { ...DEFAULT_CONFIG, region: 'zle' }).ok).toBe(false);
    expect(loadConfig(store)).toEqual(DEFAULT_CONFIG);
    saveConfig(store, { ...DEFAULT_CONFIG, company: 'inna' });
    expect(loadConfig(store).company).toBe('inna');
  });

  it('ignores corrupt stored data', () => {
    const store = memoryStore();
    store.setItem('cognifly.config', '{not json');
    expect(loadConfig(store)).toEqual(DEFAULT_CONFIG);
  });
});
