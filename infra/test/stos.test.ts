import { readFileSync } from 'node:fs';
import { describe, expect, test, beforeAll } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { StosCogniFly } from '../lib/stos.js';

const KONTEKST = { nadawca: 'nadawca@example.com', emailAlarmow: 'alarmy@example.com' };
const zbuduj = (kontekst: Record<string, string> = KONTEKST) =>
  new StosCogniFly(new App({ context: kontekst }), 'cognifly-test', {
    env: { account: '167702900577', region: 'eu-central-1' },
  });

let t: Template;
let json: Record<string, any>;
beforeAll(() => {
  t = Template.fromStack(zbuduj());
  json = t.toJSON();
}, 120_000);

const zasoby = (typ: string) => Object.entries<any>(json.Resources).filter(([, r]) => r.Type === typ);

describe('stos CogniFly', () => {
  test('brak kontekstu nadawca / emailAlarmow -> czytelny błąd', () => {
    expect(() => zbuduj({ emailAlarmow: 'a@example.com' })).toThrow(/-c nadawca=/);
    expect(() => zbuduj({ nadawca: 'a@example.com' })).toThrow(/-c emailAlarmow=/);
  });

  test('tabela: on-demand, PITR, TTL wygasa, GSI1, RETAIN', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'cognifly-test-dane',
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      TimeToLiveSpecification: { AttributeName: 'wygasa', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      GlobalSecondaryIndexes: [Match.objectLike({
        IndexName: 'GSI1',
        KeySchema: [{ AttributeName: 'gsi1pk', KeyType: 'HASH' }, { AttributeName: 'gsi1sk', KeyType: 'RANGE' }],
        Projection: { ProjectionType: 'ALL' },
      })],
    });
    t.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  });

  test('szyna cognifly-test z archiwum 30 dni', () => {
    t.hasResourceProperties('AWS::Events::EventBus', { Name: 'cognifly-test' });
    t.hasResourceProperties('AWS::Events::Archive', { RetentionDays: 30 });
  });

  test('reguła source prefix cognifly. -> Lambda przetwarzania z DLQ SQS', () => {
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: { source: [{ prefix: 'cognifly.' }] },
      Targets: [Match.objectLike({
        Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('Przetwarzanie'), 'Arn'] },
        DeadLetterConfig: { Arn: Match.anyValue() },
      })],
    });
    t.resourceCountIs('AWS::SQS::Queue', 2);
  });

  test('DLQ na poziomie funkcji (async) dla przetwarzania i eskalacji + alarmy na DLQ', () => {
    for (const fragment of ['Przetwarzanie', 'Eskalacja']) {
      const [, r] = zasoby('AWS::Lambda::Function').find(([id]) => id.includes(fragment))!;
      expect(r.Properties.DeadLetterConfig?.TargetArn, fragment).toBeDefined();
    }
    const kolejki = zasoby('AWS::CloudWatch::Alarm').filter(([, a]) => a.Properties.MetricName === 'ApproximateNumberOfMessagesVisible');
    expect(kolejki).toHaveLength(2);
    for (const [, a] of kolejki) {
      expect(a.Properties.Namespace).toBe('AWS/SQS');
      expect(a.Properties.Threshold).toBe(0);
      expect(a.Properties.ComparisonOperator).toBe('GreaterThanThreshold');
      expect(JSON.stringify(a.Properties.AlarmActions)).toContain('Alarmy');
    }
  });

  test('Lambdy: Node 22, ARM64, logi 14 dni, nazwy z prefiksem', () => {
    const lambdy = zasoby('AWS::Lambda::Function').filter(([, r]) => r.Properties.Runtime);
    expect(lambdy).toHaveLength(5);
    for (const [, r] of lambdy) {
      expect(r.Properties.Runtime).toBe('nodejs22.x');
      expect(r.Properties.Architectures).toEqual(['arm64']);
      expect(r.Properties.FunctionName).toMatch(/^cognifly-test-/);
    }
    t.resourceCountIs('AWS::Logs::LogGroup', 5);
    for (const [, r] of zasoby('AWS::Logs::LogGroup')) expect(r.Properties.RetentionInDays).toBe(14);
  });

  test('zmienne środowiskowe Lambd', () => {
    const env = (fragment: string) => {
      const [, r] = zasoby('AWS::Lambda::Function').find(([id]) => id.includes(fragment))!;
      return r.Properties.Environment.Variables as Record<string, unknown>;
    };
    expect(env('Webhook')).toMatchObject({ COGNIFLY_SZYNA: 'cognifly-test' });
    expect(env('Przetwarzanie')).toMatchObject({
      COGNIFLY_SZYNA: 'cognifly-test', COGNIFLY_NADAWCA: 'nadawca@example.com',
      COGNIFLY_GRUPA_ESKALACJI: 'cognifly-test-eskalacje',
      COGNIFLY_TABELA: 'cognifly-test-dane',
    });
    expect(env('Przetwarzanie')).toHaveProperty('COGNIFLY_ESKALACJA_ARN');
    expect(env('Przetwarzanie')).toHaveProperty('COGNIFLY_SCHEDULER_ROLA_ARN');
    expect(env('Eskalacja')).toMatchObject({ COGNIFLY_TABELA: 'cognifly-test-dane', COGNIFLY_NADAWCA: 'nadawca@example.com' });
    expect(env('Api')).toMatchObject({ COGNIFLY_TABELA: 'cognifly-test-dane' });
  });

  test('grupa Scheduler + rola, która może tylko wywołać Lambdę eskalacji', () => {
    t.hasResourceProperties('AWS::Scheduler::ScheduleGroup', { Name: 'cognifly-test-eskalacje' });
    const [, rola] = zasoby('AWS::IAM::Role').find(([id]) => id.includes('SchedulerRola'))!;
    expect(rola.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service).toBe('scheduler.amazonaws.com');
    const polityka = zasoby('AWS::IAM::Policy').find(([, p]) => JSON.stringify(p.Properties.Roles).includes('SchedulerRola'))!;
    const stm = polityka[1].Properties.PolicyDocument.Statement;
    expect(stm).toHaveLength(1);
    expect(stm[0].Action).toBe('lambda:InvokeFunction');
    expect(JSON.stringify(stm[0].Resource)).toContain('Eskalacja');
  });

  test('IAM Lambdy przetwarzania: CreateSchedule na grupie, PassRole tylko roli schedulera, SES na tożsamości', () => {
    const [, p] = zasoby('AWS::IAM::Policy').find(([id]) => id.includes('Przetwarzanie'))!;
    const stm: any[] = p.Properties.PolicyDocument.Statement;
    const dla = (akcja: string) => stm.filter((s) => ([] as string[]).concat(s.Action).includes(akcja));
    const cs = dla('scheduler:CreateSchedule');
    expect(cs).toHaveLength(1);
    expect(JSON.stringify(cs[0].Resource)).toContain('schedule/cognifly-test-eskalacje/*');
    const pr = dla('iam:PassRole');
    expect(pr).toHaveLength(1);
    expect(JSON.stringify(pr[0].Resource)).toContain('SchedulerRola');
    const ses = dla('ses:SendEmail');
    expect(ses).toHaveLength(1);
    expect(JSON.stringify(ses[0].Resource)).toContain(':identity/*');
    expect(ses[0].Condition).toEqual({ StringEquals: { 'ses:FromAddress': 'nadawca@example.com' } });
    const sm = dla('secretsmanager:GetSecretValue');
    expect(sm).toHaveLength(1);
    expect(JSON.stringify(sm[0].Resource)).toContain('secret:cognifly-test/discord/*');
    expect(JSON.stringify(sm[0].Resource)).not.toContain('github');
    // żadnych gwiazdek na zasobach
    for (const s of stm) expect(s.Resource).not.toBe('*');
  });

  test('HTTP API: webhook bez autoryzatora, 17 tras API z JWT (pula + klient)', () => {
    const trasy = zasoby('AWS::ApiGatewayV2::Route').map(([, r]) => r.Properties);
    expect(trasy).toHaveLength(18);
    const wh = trasy.find((r) => r.RouteKey === 'POST /webhook/github/{firma}');
    expect(wh).toBeDefined();
    expect(wh.AuthorizationType ?? 'NONE').toBe('NONE');
    expect(wh.AuthorizerId).toBeUndefined();
    for (const k of ['GET /zdarzenia', 'GET /skrzynka', 'GET /zadania/{id}', 'POST /zadania/{id}/biore', 'POST /zadania/{id}/stan', 'POST /zadania/{id}/przekaz', 'POST /zadania/{id}/odrzuc', 'POST /zadania/{id}/usun', 'POST /zadania/{id}/watek', 'POST /zadania/{id}/akceptuj', 'POST /zadania/{id}/do-poprawy', 'GET /podsumowanie', 'GET /ja']) {
      const r = trasy.find((x) => x.RouteKey === k);
      expect(r, k).toBeDefined();
      expect(r.AuthorizationType).toBe('JWT');
      expect(r.AuthorizerId).toBeDefined();
    }
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: { Audience: [{ Ref: Match.stringLikeRegexp('Klient') }], Issuer: Match.anyValue() },
    });
  });

  test('Cognito: Essentials, e-mail, bez samodzielnej rejestracji, EMAIL_OTP, klient publiczny', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'cognifly-test-uzytkownicy',
      UserPoolTier: 'ESSENTIALS',
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      EmailConfiguration: Match.objectLike({ EmailSendingAccount: 'DEVELOPER', From: 'nadawca@example.com' }),
      Policies: { SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'] } },
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']),
    });
    const [, k] = zasoby('AWS::Cognito::UserPoolClient')[0]!;
    expect(k.Properties.AllowedOAuthFlows).toBeUndefined();
    expect(k.Properties.CallbackURLs).toBeUndefined();
    expect(k.Properties.AllowedOAuthFlowsUserPoolClient ?? false).toBe(false);
    expect(k.Properties.ExplicitAuthFlows.sort()).toEqual(['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_AUTH']);
  });

  test('alarmy błędów Lambd -> SNS -> e-mail', () => {
    t.resourceCountIs('AWS::CloudWatch::Alarm', 7);
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors', Namespace: 'AWS/Lambda', Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold', AlarmActions: [{ Ref: Match.stringLikeRegexp('Alarmy') }],
    });
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'alarmy@example.com' });
  });

  test('wyjścia stosu', () => {
    expect(Object.keys(json.Outputs).sort()).toEqual(
      ['AdresApi', 'AdresWebhookGithub', 'KlientCognito', 'NazwaSzyny', 'PulaCognito', 'Region'],
    );
    expect(JSON.stringify(json.Outputs.AdresWebhookGithub)).toContain('/webhook/github/{firma}');
    expect(JSON.stringify(json.Outputs.NazwaSzyny.Value)).toContain('Szyna');
  });

  test('wyjście Region = region stosu', () => {
    expect(json.Outputs.Region.Value).toBe('eu-central-1');
  });

  test('IAM sekretów zawężone: webhook tylko github/*, eskalacja i przetwarzanie tylko discord/*', () => {
    const sekretyDla = (frag: string) => {
      const [, p] = zasoby('AWS::IAM::Policy').find(([id]) => id.includes(frag))!;
      const stm: any[] = p.Properties.PolicyDocument.Statement;
      return stm.filter((s) => ([] as string[]).concat(s.Action).includes('secretsmanager:GetSecretValue'));
    };
    const w = sekretyDla('Webhook');
    expect(w).toHaveLength(1);
    expect(JSON.stringify(w[0].Resource)).toContain('secret:cognifly-test/github/*');
    for (const f of ['Przetwarzanie', 'Eskalacja']) {
      const s = sekretyDla(f);
      expect(s).toHaveLength(1);
      expect(JSON.stringify(s[0].Resource)).toContain('secret:cognifly-test/discord/*');
    }
    for (const f of ['Api', 'Dostarczenia']) {
      const s = sekretyDla(f);
      expect(s).toHaveLength(1);
      expect(JSON.stringify(s[0].Resource)).toContain('secret:cognifly-test/github-odczyt/*');
    }
  });

  test('każda trasa obsługiwana przez Lambdę API istnieje w API Gateway z JWT', () => {
    const zrodlo = readFileSync(new URL('../../serwer/src/api/index.ts', import.meta.url), 'utf8');
    const klucze = [...zrodlo.matchAll(/'((?:GET|POST) \/[^']+)'/g)].map((m) => m[1]);
    expect(klucze.length).toBeGreaterThan(5);
    const trasy = zasoby('AWS::ApiGatewayV2::Route').map(([, r]) => r.Properties);
    for (const k of klucze) {
      const r = trasy.find((x) => x.RouteKey === k);
      expect(r, k).toBeDefined();
      expect(r.AuthorizationType, k).toBe('JWT');
    }
  });

  test('dostarczenia: Lambda, reguła sygnałów z webhooka (poza potokiem zdarzeń) i harmonogram co 10 min', () => {
    const [, f] = zasoby('AWS::Lambda::Function').find(([, r]) => r.Properties.FunctionName === 'cognifly-test-dostarczenia')!;
    expect(f).toBeDefined();
    t.hasResourceProperties('AWS::Events::Rule', {
      Name: 'cognifly-test-dostarczenia',
      EventPattern: { source: ['dostarczenia.github'] },
    });
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'cognifly-test-dostarczenia', ScheduleExpression: 'rate(10 minutes)',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });
    const [, rola] = zasoby('AWS::IAM::Role').find(([id]) => id.includes('PrzegladDostarczenRola'))!;
    expect(JSON.stringify(rola.Properties.AssumeRolePolicyDocument)).toContain('aws:SourceAccount');
  });

  test('Cognito: odzyskiwanie konta tylko e-mailem', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
    });
  });

  test('kontekst domenaSes -> SES z zweryfikowaną domeną; tabela i pula nadal RETAIN', () => {
    const t2 = Template.fromStack(zbuduj({ ...KONTEKST, domenaSes: 'example.com' }));
    t2.hasResourceProperties('AWS::Cognito::UserPool', {
      EmailConfiguration: Match.objectLike({ EmailSendingAccount: 'DEVELOPER', From: 'nadawca@example.com' }),
    });
    const ses = JSON.stringify(Object.values<any>(t2.toJSON().Resources).find((r) => r.Type === 'AWS::Cognito::UserPool'));
    expect(ses).toContain('identity/example.com');
    t2.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain' });
    t2.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  });

  test('tag Project=cognifly na zasobach z tagami', () => {
    const z = zasoby('AWS::DynamoDB::Table')[0]![1];
    expect(z.Properties.Tags).toContainEqual({ Key: 'Project', Value: 'cognifly' });
    const f = zasoby('AWS::Lambda::Function')[0]![1];
    expect(f.Properties.Tags).toContainEqual({ Key: 'Project', Value: 'cognifly' });
  });
});

describe('stos z kontekstem heartwood', () => {
  const HW = JSON.stringify({ intUrl: 'https://hw.example.com/prod', intApiArn: 'arn:aws:execute-api:eu-west-1:111122223333:abc123' });

  test('bez kontekstu heartwood brak strumienia i funkcji Heartwood', () => {
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
    expect(json.Resources[zasoby('AWS::DynamoDB::Table')[0]![0]].Properties.StreamSpecification).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain('Heartwood');
  });

  test('z kontekstem: strumień, mapowanie, reguła i uprawnienie Invoke', () => {
    const t2 = Template.fromStack(zbuduj({ ...KONTEKST, heartwood: HW }));
    t2.hasResourceProperties('AWS::DynamoDB::Table', { StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' } });
    t2.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionName: { Ref: Match.stringLikeRegexp('HeartwoodPraca') },
      FunctionResponseTypes: ['ReportBatchItemFailures'], MaximumRetryAttempts: 10, BisectBatchOnFunctionError: true,
    });
    t2.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['heartwood'],
        'detail-type': ['lock.release_requested', 'change.rejected', 'lock.broken', 'quota.near', 'quota.exceeded'],
      },
    });
    t2.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: 'execute-api:Invoke', Resource: 'arn:aws:execute-api:eu-west-1:111122223333:abc123/*/*/int/*',
      })]) },
    });
    for (const n of ['HeartwoodPraca', 'HeartwoodZdarzenia']) {
      t2.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `cognifly-test-${n.toLowerCase()}`,
        Environment: { Variables: Match.objectLike({ HEARTWOOD_INT_URL: 'https://hw.example.com/prod' }) },
      });
    }
  });

  test('zły kontekst heartwood -> czytelny błąd', () => {
    expect(() => zbuduj({ ...KONTEKST, heartwood: '{nie json' })).toThrow(/"heartwood"/);
    expect(() => zbuduj({ ...KONTEKST, heartwood: '{"intUrl":"https://x"}' })).toThrow(/intApiArn/);
  });
});
