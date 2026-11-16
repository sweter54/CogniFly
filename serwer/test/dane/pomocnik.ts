import { CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { surowyKlient } from '../../src/dane/tabela.js';
import { definicjaTabeli } from '../../src/dane/tabela.js';

/** Każdy plik testowy dostaje własną tabelę (pliki biegną równolegle). */
export function ustawTabeleTestowa(nazwa: string) {
  process.env.COGNIFLY_TABELA = nazwa;
  process.env.DYNAMODB_ENDPOINT ??= 'http://localhost:8000';
  return {
    async utworz() {
      await surowyKlient().send(new DeleteTableCommand({ TableName: nazwa })).catch(() => {});
      await surowyKlient().send(new CreateTableCommand(definicjaTabeli(nazwa)));
    },
    async usun() {
      await surowyKlient().send(new DeleteTableCommand({ TableName: nazwa })).catch(() => {});
    },
  };
}
