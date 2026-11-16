import { describe, expect, it } from 'vitest';
import { taskFromAppLink } from '../src/logic/app-link.js';

describe('taskFromAppLink', () => {
  it('accepts cognifly://zadanie/<id>', () => {
    expect(taskFromAppLink('cognifly://zadanie/zad_0123456789ab')).toBe('zad_0123456789ab');
  });

  it.each([
    'cognifly://zadanie/zad_zly',
    'cognifly://zadanie/zad_0123456789ab?usun=1',
    'cognifly://inne/zad_0123456789ab',
    'https://zadanie/zad_0123456789ab',
    'cognifly://zadanie/zad_0123456789ab/../x',
    'nie link',
  ])('rejects %s', (link) => {
    expect(taskFromAppLink(link)).toBeNull();
  });
});
