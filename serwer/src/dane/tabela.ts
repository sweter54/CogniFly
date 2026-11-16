import { DynamoDBClient, TransactionCanceledException, type CreateTableCommandInput } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

export const nazwaTabeli = (): string => process.env.COGNIFLY_TABELA ?? 'cognifly-test-dane';

let surowy: DynamoDBClient | undefined;
let dok: DynamoDBDocumentClient | undefined;

export function surowyKlient(): DynamoDBClient {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  surowy ??= new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'eu-central-1',
    ...(endpoint
      ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
      : {}),
  });
  return surowy;
}

export function klient(): DynamoDBDocumentClient {
  dok ??= DynamoDBDocumentClient.from(surowyKlient(), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return dok;
}

/** Jedyna definicja tabeli — używają jej testy; CDK (Task 8) ma ją odzwierciedlać. TTL: atrybut `wygasa`. */
export function definicjaTabeli(nazwa: string = nazwaTabeli()): CreateTableCommandInput {
  return {
    TableName: nazwa,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
      { AttributeName: 'gsi1pk', AttributeType: 'S' },
      { AttributeName: 'gsi1sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'GSI1',
        KeySchema: [
          { AttributeName: 'gsi1pk', KeyType: 'HASH' },
          { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  };
}

export const ATRYBUT_TTL = 'wygasa';

export const pauza = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Transakcja z rozróżnieniem przyczyn anulowania.
 * 'OK' | 'WARUNEK' (ConditionalCheckFailed na pierwszym elemencie).
 * TransactionConflict jest ponawiany (maks. 4 próby z krótkim backoffem), potem wyjątek; reszta błędów leci dalej.
 */
export async function transakcja(items: TransactWriteCommandInput['TransactItems']): Promise<'OK' | 'WARUNEK'> {
  const PROB = 4;
  for (let i = 1; ; i++) {
    try {
      await klient().send(new TransactWriteCommand({ TransactItems: items }));
      return 'OK';
    } catch (e) {
      if (!(e instanceof TransactionCanceledException)) throw e;
      const kody = (e.CancellationReasons ?? []).map((r) => r.Code);
      if (kody.includes('TransactionConflict')) {
        if (i >= PROB) throw e;
        await pauza(10 * 2 ** i + Math.random() * 10);
        continue;
      }
      if (kody[0] === 'ConditionalCheckFailed') return 'WARUNEK';
      throw e;
    }
  }
}
