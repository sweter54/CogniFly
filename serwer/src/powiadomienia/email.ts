import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { Wiadomosc } from './format.js';

let ses: SESv2Client | undefined;

export const escapujHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export async function wyslijEmail(adres: string, wiad: Wiadomosc, klient?: Pick<SESv2Client, 'send'>): Promise<void> {
  const nadawca = process.env.COGNIFLY_NADAWCA;
  if (!nadawca) throw new Error('brak zmiennej COGNIFLY_NADAWCA');
  ses ??= new SESv2Client({});
  const html = `<div style="white-space:pre-wrap">${escapujHtml(wiad.tekst)}</div>`;
  await (klient ?? ses).send(
    new SendEmailCommand({
      FromEmailAddress: nadawca,
      Destination: { ToAddresses: [adres] },
      Content: {
        Simple: {
          Subject: { Data: wiad.temat, Charset: 'UTF-8' },
          Body: { Text: { Data: wiad.tekst, Charset: 'UTF-8' }, Html: { Data: html, Charset: 'UTF-8' } },
        },
      },
    }),
  );
}
