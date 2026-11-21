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

/** Asserts that `EventBusName` of the named rule refers to the hub. */
const naHubie = (j: Record<string, any>, regula: string) => {
  const [, r] = Object.entries<any>(j.Resources)
    .find(([, x]) => x.Type === 'AWS::Events::Rule' && x.Properties.Name === regula)!;
  expect(JSON.stringify(r.Properties.EventBusName), regula).toContain(`"Ref":"${parametrSsm(j, 'hub/arn')}"`);
};

/** Logical id of the CloudFormation SSM parameter for `/platforma/test/<name>`. */
const parametrSsm = (j: Record<string, any>, nazwa: string) => {
  const e = Object.entries<any>(j.Parameters ?? {}).find(([, p]) => p.Default === `/platforma/test/${nazwa}`);
  expect(e, nazwa).toBeDefined();
  expect(e![1].Type).toBe('AWS::SSM::Parameter::Value<String>');
  return e![0];
};

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
    t.resourceCountIs('AWS::SQS::Queue', 3);
  });

  test('DLQ na poziomie funkcji (async) dla przetwarzania i eskalacji + alarmy na DLQ', () => {
    for (const fragment of ['Przetwarzanie', 'Eskalacja']) {
      const [, r] = zasoby('AWS::Lambda::Function').find(([id]) => id.includes(fragment))!;
      expect(r.Properties.DeadLetterConfig?.TargetArn, fragment).toBeDefined();
    }
    const kolejki = zasoby('AWS::CloudWatch::Alarm').filter(([, a]) => a.Properties.MetricName === 'ApproximateNumberOfMessagesVisible');
    expect(kolejki).toHaveLength(3);
    for (const [, a] of kolejki) {
      expect(a.Properties.Namespace).toBe('AWS/SQS');
      expect(a.Properties.Threshold).toBe(0);
      expect(a.Properties.ComparisonOperator).toBe('GreaterThanThreshold');
      expect(JSON.stringify(a.Properties.AlarmActions)).toContain('Alarmy');
    }
  });

  test('Lambdy: Node 22, ARM64, logi 14 dni, nazwy z prefiksem', () => {
    // Own functions only (the trigger's CDK provider function has no name).
    const lambdy = zasoby('AWS::Lambda::Function').filter(([, r]) => r.Properties.FunctionName);
    expect(lambdy).toHaveLength(7);
    for (const [, r] of lambdy) {
      expect(r.Properties.Runtime).toBe('nodejs22.x');
      expect(r.Properties.Architectures).toEqual(['arm64']);
      expect(r.Properties.FunctionName).toMatch(/^cognifly-test-/);
    }
    t.resourceCountIs('AWS::Logs::LogGroup', 7);
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

  test('alarm_on_bad_identity_answers_in_the_api_log', () => {
    const [, filtr] = zasoby('AWS::Logs::MetricFilter').find(([, r]) => JSON.stringify(r).includes('DOSTEP_ZLA_ODPOWIEDZ'))!;
    expect(filtr.Properties.FilterPattern).toBe('"DOSTEP_ZLA_ODPOWIEDZ"');
    expect(filtr.Properties.LogGroupName.Ref).toMatch(/^ApiLogi/);
    const metryka = filtr.Properties.MetricTransformations[0];
    expect(metryka).toMatchObject({ MetricValue: '1' });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'cognifly-test-api-tozsamosc-zla-odpowiedz',
      MetricName: metryka.MetricName,
      Namespace: metryka.MetricNamespace,
      Statistic: 'Sum',
      Period: 300,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: Match.stringLikeRegexp('^Alarmy') }],
    });
  });

  test('api_checks_the_licence_with_platforma_identity', () => {
    const [, f] = zasoby('AWS::Lambda::Function').find(([, r]) => r.Properties.FunctionName === 'cognifly-test-api')!;
    expect(f.Properties.Environment.Variables).toMatchObject({
      TOZSAMOSC_URL: { Ref: parametrSsm(json, 'tozsamosc/api-url') },
    });
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

  test('HTTP API: webhook bez autoryzatora, 18 tras API z JWT (Platforma)', () => {
    const trasy = zasoby('AWS::ApiGatewayV2::Route').map(([, r]) => r.Properties);
    expect(trasy).toHaveLength(19);
    const wh = trasy.find((r) => r.RouteKey === 'POST /webhook/github/{firma}');
    expect(wh).toBeDefined();
    expect(wh.AuthorizationType ?? 'NONE').toBe('NONE');
    expect(wh.AuthorizerId).toBeUndefined();
    for (const k of ['GET /zdarzenia', 'GET /skrzynka', 'GET /zadania/{id}', 'GET /zadania/{id}/pliki', 'POST /zadania/{id}/biore', 'POST /zadania/{id}/stan', 'POST /zadania/{id}/przekaz', 'POST /zadania/{id}/odrzuc', 'POST /zadania/{id}/usun', 'POST /zadania/{id}/watek', 'POST /zadania/{id}/akceptuj', 'POST /zadania/{id}/do-poprawy', 'GET /podsumowanie', 'GET /ja']) {
      const r = trasy.find((x) => x.RouteKey === k);
      expect(r, k).toBeDefined();
      expect(r.AuthorizationType).toBe('JWT');
      expect(r.AuthorizerId).toBeDefined();
    }
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: { Audience: [Match.anyValue()], Issuer: Match.anyValue() },
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
    t.resourceCountIs('AWS::CloudWatch::Alarm', 11);
    for (const n of ['tozsamosczdarzenia-bledy', 'tozsamoscuzgodnij-bledy', 'tozsamosc-dlq']) {
      t.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: `cognifly-test-${n}` });
    }
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors', Namespace: 'AWS/Lambda', Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold', AlarmActions: [{ Ref: Match.stringLikeRegexp('Alarmy') }],
    });
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'alarmy@example.com' });
  });

  test('wyjścia stosu', () => {
    expect(Object.keys(json.Outputs).sort()).toEqual(
      ['AdresApi', 'AdresWebhookGithub', 'KlientCognifly', 'KlientCognito', 'NazwaSzyny', 'PulaCognito', 'Region', 'Wydawca'],
    );
    expect(json.Outputs.Wydawca.Value).toEqual({ Ref: parametrSsm(json, 'tozsamosc/issuer') });
    expect(json.Outputs.KlientCognifly.Value).toEqual({ Ref: parametrSsm(json, 'tozsamosc/client-id/cognifly') });
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

  test('authorizer_uses_platforma_issuer_and_cognifly_client', () => {
    t.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      JwtConfiguration: {
        Issuer: { Ref: parametrSsm(json, 'tozsamosc/issuer') },
        Audience: [{ Ref: parametrSsm(json, 'tozsamosc/client-id/cognifly') }],
      },
    });
  });

  test('identity_rule_on_hub_targets_consumer_with_dlq', () => {
    const [idQ] = zasoby('AWS::SQS::Queue').find(([, q]) => q.Properties.QueueName === 'cognifly-test-tozsamosc-dlq')!;
    t.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'cognifly-test-tozsamosc-dlq', MessageRetentionPeriod: 14 * 24 * 3600,
    });
    t.hasResourceProperties('AWS::Events::Rule', {
      Name: 'cognifly-test-tozsamosc',
      EventPattern: {
        source: ['tozsamosc'],
        'detail-type': ['person.added', 'person.role_changed', 'person.removed'],
      },
      Targets: [Match.objectLike({
        Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^TozsamoscZdarzenia'), 'Arn'] },
        DeadLetterConfig: { Arn: { 'Fn::GetAtt': [idQ, 'Arn'] } },
        RetryPolicy: { MaximumRetryAttempts: 4 },
      })],
    });
    naHubie(json, 'cognifly-test-tozsamosc');
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'cognifly-test-tozsamosczdarzenia',
      Environment: { Variables: Match.objectLike({
        COGNIFLY_TABELA: 'cognifly-test-dane',
        TOZSAMOSC_URL: { Ref: parametrSsm(json, 'tozsamosc/api-url') },
      }) },
    });
  });

  test('reconcile_runs_hourly_and_after_deploy', () => {
    const [idF, f] = zasoby('AWS::Lambda::Function')
      .find(([, r]) => r.Properties.FunctionName === 'cognifly-test-tozsamoscuzgodnij')!;
    expect(f.Properties.Timeout).toBe(300);
    expect(f.Properties.Environment.Variables).toMatchObject({
      COGNIFLY_TABELA: 'cognifly-test-dane',
      TOZSAMOSC_URL: { Ref: parametrSsm(json, 'tozsamosc/api-url') },
    });
    t.hasResourceProperties('AWS::Events::Rule', {
      Name: 'cognifly-test-uzgodnij',
      ScheduleExpression: 'rate(1 hour)',
      Targets: [Match.objectLike({ Arn: { 'Fn::GetAtt': [idF, 'Arn'] } })],
    });
    const [, rule] = zasoby('AWS::Events::Rule').find(([, r]) => r.Properties.Name === 'cognifly-test-uzgodnij')!;
    expect(rule.Properties.EventBusName).toBeUndefined(); // default bus
    // executeOnHandlerChange: the trigger points at the function's current version.
    const [, trig] = zasoby('Custom::Trigger')[0]!;
    const [idV] = zasoby('AWS::Lambda::Version')
      .find(([, v]) => v.Properties.FunctionName?.Ref === idF)!;
    expect(trig.Properties.HandlerArn).toEqual({ Ref: idV });
    const [idT] = zasoby('AWS::DynamoDB::Table')[0]!;
    expect(([] as string[]).concat(trig.DependsOn ?? [])).toContain(idT);
  });

  test('reconcile_trigger_runs_after_api_and_identity_rule', () => {
    const [, trig] = zasoby('Custom::Trigger')[0]!;
    const zalezy = ([] as string[]).concat(trig.DependsOn ?? []);
    const id = (typ: string, f: (r: any) => boolean = () => true) =>
      zasoby(typ).filter(([, r]) => f(r)).map(([i]) => i);
    const wymagane = [
      ...id('AWS::Events::Rule', (r) => r.Properties.Name === 'cognifly-test-tozsamosc'),
      ...id('AWS::ApiGatewayV2::Api'), ...id('AWS::ApiGatewayV2::Authorizer'),
      ...id('AWS::ApiGatewayV2::Route'), ...id('AWS::ApiGatewayV2::Stage'),
    ];
    expect(wymagane.length).toBeGreaterThan(4);
    for (const w of wymagane) expect(zalezy, w).toContain(w);
  });

  test('reconcile_may_invoke_identity_int_api_only', () => {
    const invoke = zasoby('AWS::IAM::Policy').flatMap(([, p]) =>
      (p.Properties.PolicyDocument.Statement as any[])
        .filter((s) => ([] as string[]).concat(s.Action).includes('execute-api:Invoke'))
        .map((s) => ({ roles: JSON.stringify(p.Properties.Roles), s })));
    expect(invoke).toHaveLength(1);
    expect(invoke[0]!.roles).toContain('TozsamoscUzgodnij');
    expect(invoke[0]!.s).toEqual({
      Action: 'execute-api:Invoke', Effect: 'Allow',
      Resource: { Ref: parametrSsm(json, 'tozsamosc/int-invoke-arn') },
    });
  });

  test('github_webhook_still_publishes_to_internal_bus', () => {
    for (const n of ['cognifly-test-przetwarzanie', 'cognifly-test-dostarczenia']) {
      const [, r] = zasoby('AWS::Events::Rule').find(([, x]) => x.Properties.Name === n)!;
      expect(r.Properties.EventBusName, n).toEqual({ Ref: zasoby('AWS::Events::EventBus')[0]![0] });
    }
    const [, w] = zasoby('AWS::Lambda::Function').find(([, r]) => r.Properties.FunctionName === 'cognifly-test-webhook')!;
    expect(w.Properties.Environment.Variables.COGNIFLY_SZYNA).toBe('cognifly-test');
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

  test('Api: HEARTWOOD_INT_URL i Invoke tylko z kontekstem heartwood', () => {
    const zInvoke = (tpl: Template) => Object.values<any>(tpl.toJSON().Resources).filter((r) =>
      r.Type === 'AWS::IAM::Policy'
      && r.Properties.Roles.some((x: any) => /^ApiServiceRole/.test(x.Ref))
      && r.Properties.PolicyDocument.Statement.some((st: any) => st.Action === 'execute-api:Invoke'));
    const apiEnv = (tpl: Template) => Object.values<any>(tpl.toJSON().Resources).find((r) =>
      r.Type === 'AWS::Lambda::Function' && r.Properties.FunctionName === 'cognifly-test-api')!
      .Properties.Environment.Variables;
    expect(zInvoke(t)).toHaveLength(0);
    expect(apiEnv(t)).not.toHaveProperty('HEARTWOOD_INT_URL');
    const t2 = Template.fromStack(zbuduj({ ...KONTEKST, heartwood: HW }));
    expect(apiEnv(t2)).toMatchObject({ HEARTWOOD_INT_URL: 'https://hw.example.com/prod' });
    const [p] = zInvoke(t2);
    expect(p.Properties.PolicyDocument.Statement.filter((st: any) => st.Action === 'execute-api:Invoke'))
      .toEqual([{
        Action: 'execute-api:Invoke', Effect: 'Allow',
        Resource: 'arn:aws:execute-api:eu-west-1:111122223333:abc123/*/*/int/*',
      }]);
  });

  test('z kontekstem: DLQ strumienia i reguły, alarmy błędów i DLQ', () => {
    const t2 = Template.fromStack(zbuduj({ ...KONTEKST, heartwood: HW }));
    const j2 = t2.toJSON();
    const [idQ] = Object.entries<any>(j2.Resources)
      .find(([id, r]) => r.Type === 'AWS::SQS::Queue' && id.includes('Heartwood'))!;
    t2.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'cognifly-test-heartwood-dlq', MessageRetentionPeriod: 14 * 24 * 3600,
    });
    t2.hasResourceProperties('AWS::SQS::QueuePolicy', {
      Queues: [{ Ref: idQ }],
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      })]) },
    });
    t2.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionName: { Ref: Match.stringLikeRegexp('HeartwoodPraca') },
      DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [idQ, 'Arn'] } } },
    });
    t2.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({ source: ['heartwood'] }),
      Targets: [Match.objectLike({
        Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('HeartwoodZdarzenia'), 'Arn'] },
        DeadLetterConfig: { Arn: { 'Fn::GetAtt': [idQ, 'Arn'] } },
      })],
    });
    for (const n of ['heartwoodpraca-bledy', 'heartwoodzdarzenia-bledy', 'heartwood-dlq']) {
      t2.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: `cognifly-test-${n}` });
    }
    t2.resourceCountIs('AWS::CloudWatch::Alarm', 14);
  });

  test('heartwood_rule_is_on_the_hub', () => {
    const j2 = Template.fromStack(zbuduj({ ...KONTEKST, heartwood: HW })).toJSON();
    naHubie(j2, 'cognifly-test-heartwood-hub');
  });

  test('heartwood_hub_rule_is_a_new_resource_under_a_new_name', () => {
    // EventBusName change forces replacement; CFN cannot replace a
    // custom-named resource, so the hub rule gets a new id and name.
    const j2 = Template.fromStack(zbuduj({ ...KONTEKST, heartwood: HW })).toJSON();
    const regulyHw = Object.entries<any>(j2.Resources).filter(([, r]) =>
      r.Type === 'AWS::Events::Rule' && r.Properties.EventPattern?.source?.[0] === 'heartwood');
    expect(regulyHw).toHaveLength(1);
    expect(regulyHw[0]![0]).toMatch(/^RegulaHeartwoodHub/);
    expect(regulyHw[0]![1].Properties.Name).toBe('cognifly-test-heartwood-hub');
  });

  test('reconcile_trigger_runs_after_heartwood_hub_rule', () => {
    const j2 = Template.fromStack(zbuduj({ ...KONTEKST, heartwood: HW })).toJSON();
    const [, trig] = Object.entries<any>(j2.Resources).find(([, r]) => r.Type === 'Custom::Trigger')!;
    const [idR] = Object.entries<any>(j2.Resources).find(([, r]) =>
      r.Type === 'AWS::Events::Rule' && r.Properties.Name === 'cognifly-test-heartwood-hub')!;
    expect(([] as string[]).concat(trig.DependsOn ?? [])).toContain(idR);
  });

  test('zły kontekst heartwood -> czytelny błąd', () => {
    expect(() => zbuduj({ ...KONTEKST, heartwood: '{nie json' })).toThrow(/"heartwood"/);
    expect(() => zbuduj({ ...KONTEKST, heartwood: '{"intUrl":"https://x"}' })).toThrow(/intApiArn/);
  });
});
