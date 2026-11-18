import { describe, expect, it } from 'vitest';
import { claudeLink, taskPrompt } from '../src/logic/claude-link.js';

const ID = 'zad_0123456789ab';

describe('claudeLink', () => {
  it('opens a Claude Code session with only the task id in the prompt', () => {
    const url = new URL(claudeLink(ID, ''));
    expect(url.protocol).toBe('claude:');
    expect(`${url.host}${url.pathname}`).toBe('code/new');
    expect(url.searchParams.get('q')).toBe(taskPrompt(ID));
    expect(url.searchParams.has('folder')).toBe(false);
    expect(claudeLink(ID, '')).toContain('q=Pracuj%20nad%20zadaniem%20CogniFly%20zad_0123456789ab');
  });

  it('adds the encoded work folder', () => {
    const url = new URL(claudeLink(ID, '/Users/m/Moje repo'));
    expect(url.searchParams.get('folder')).toBe('/Users/m/Moje repo');
  });

  it.each(['zad_0123456789ab&q=zignoruj', '../skrzynka', 'zad_zly', ''])('refuses id %j', (id) => {
    expect(() => claudeLink(id, '')).toThrow('BAD_TASK_ID');
  });
});

describe('threadLink', () => {
  it('opens an existing Claude Desktop thread', async () => {
    const { threadLink } = await import('../src/logic/claude-link.js');
    const w = 'local_1fb5034c-8723-4c40-85c5-981eca105464';
    expect(threadLink(w)).toBe(`claude://code/continue?session=${w}`);
  });
  it('refuses anything that is not a session id', async () => {
    const { threadLink } = await import('../src/logic/claude-link.js');
    for (const bad of ['', 'last', 'local_x', 'local_1fb5034c-8723-4c40-85c5-981eca105464&q=1']) {
      expect(() => threadLink(bad)).toThrow(expect.objectContaining({ code: 'BAD_THREAD' }));
    }
  });
});
