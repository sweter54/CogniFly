import { beforeEach, describe, expect, test } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { wyslijEmail } from '../../src/powiadomienia/email.js';

const ses = mockClient(SESv2Client);
beforeEach(() => {
  ses.reset();
  ses.on(SendEmailCommand).resolves({});
  process.env.COGNIFLY_NADAWCA = 'cognifly@example.com';
});

describe('wyslijEmail', () => {
  test('wysyła tekst i HTML z escapowaniem', async () => {
    await wyslijEmail('ala@example.com', { temat: 'T', tekst: 'a <b> & "c"', discord: {} });
    const i = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(i.FromEmailAddress).toBe('cognifly@example.com');
    expect(i.Destination?.ToAddresses).toEqual(['ala@example.com']);
    expect(i.Content?.Simple?.Subject?.Data).toBe('T');
    expect(i.Content?.Simple?.Body?.Text?.Data).toBe('a <b> & "c"');
    const html = i.Content?.Simple?.Body?.Html?.Data ?? '';
    expect(html).toContain('a &lt;b&gt; &amp; &quot;c&quot;');
    expect(html).not.toContain('<b>');
  });

  test('brak COGNIFLY_NADAWCA -> wyjątek', async () => {
    delete process.env.COGNIFLY_NADAWCA;
    await expect(wyslijEmail('a@b.c', { temat: 'T', tekst: 'x', discord: {} })).rejects.toThrow(/COGNIFLY_NADAWCA/);
  });
});
