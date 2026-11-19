import { describe, expect, it, vi } from 'vitest';
import { handleIdentityEvent, type EventDeps } from '../../src/tozsamosc/zdarzenia.js';

const TIME = '2026-11-19T10:00:00Z';
const ev = (type: string, detail: unknown) => ({ 'detail-type': type, time: TIME, detail });

const fakes = () => {
  const d = {
    applyMember: vi.fn(async () => 'updated' as const),
    removeMember: vi.fn(async () => 'removed' as const),
    log: vi.fn(),
  };
  return d satisfies EventDeps;
};

describe('handleIdentityEvent', () => {
  it('person_added_applies_member_with_event_time', async () => {
    const d = fakes();
    await handleIdentityEvent(ev('person.added', { org: 'pilot', sub: 's1', email: 'a@x.pl', role: 'admin' }), d);
    expect(d.applyMember).toHaveBeenCalledWith('pilot', { sub: 's1', email: 'a@x.pl', role: 'admin' }, TIME);
    expect(d.removeMember).not.toHaveBeenCalled();
  });

  it('role_changed_updates_role_only', async () => {
    const d = fakes();
    await handleIdentityEvent(ev('person.role_changed', { org: 'pilot', sub: 's1', role: 'member' }), d);
    expect(d.applyMember).toHaveBeenCalledWith('pilot', { sub: 's1', role: 'member' }, TIME);
  });

  it('role_changed_for_unknown_sub_is_logged', async () => {
    const d = fakes();
    d.applyMember.mockResolvedValueOnce('skipped' as never);
    await handleIdentityEvent(ev('person.role_changed', { org: 'pilot', sub: 'sx', role: 'member' }), d);
    expect(d.log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ result: 'skipped' }));
  });

  it('person_removed_removes_member', async () => {
    const d = fakes();
    await handleIdentityEvent(ev('person.removed', { org: 'pilot', sub: 's1' }), d);
    expect(d.removeMember).toHaveBeenCalledWith('pilot', 's1', TIME);
    expect(d.applyMember).not.toHaveBeenCalled();
  });

  it('org_events_and_bad_detail_are_ignored', async () => {
    const d = fakes();
    const bad = [
      ev('org.created', { org: 'pilot' }),
      ev('org.suspended', { org: 'pilot' }),
      ev('person.added', { org: 'pilot', sub: 's1', role: 'admin' }),
      ev('person.added', { org: 'pilot', sub: 's1', email: 'a@x.pl', role: 'owner' }),
      ev('person.role_changed', { org: 'pilot', role: 'admin' }),
      ev('person.removed', { org: '', sub: 's1' }),
      ev('person.removed', null),
      ev('person.removed', 'x'),
    ];
    for (const e of bad) await expect(handleIdentityEvent(e, d)).resolves.toBeUndefined();
    expect(d.applyMember).not.toHaveBeenCalled();
    expect(d.removeMember).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledTimes(bad.length);
  });

  it('logs_never_contain_email', async () => {
    const d = fakes();
    await handleIdentityEvent(ev('person.added', { org: 'pilot', sub: 's1', email: 'secret@x.pl', role: 'nope' }), d);
    await handleIdentityEvent(ev('person.added', { org: 'pilot', sub: 's1', email: 'secret@x.pl', role: 'admin' }), d);
    expect(JSON.stringify(d.log.mock.calls)).not.toContain('secret@x.pl');
  });

  it('storage_errors_propagate', async () => {
    const d = fakes();
    d.removeMember.mockRejectedValueOnce(new Error('ddb') as never);
    await expect(handleIdentityEvent(ev('person.removed', { org: 'pilot', sub: 's1' }), d)).rejects.toThrow('ddb');
  });
});
