import { fileURLToPath } from 'node:url';
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import { CfnSchedule, CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { AccountRecovery, FeaturePlan, UserPool, UserPoolEmail, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, BillingMode, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { EventBus, Match, Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

const PREFIKS = 'cognifly-test';
const NAZWA_TABELI = `${PREFIKS}-dane`;
const NAZWA_SZYNY = PREFIKS;
const NAZWA_GRUPY = `${PREFIKS}-eskalacje`;

const serwer = (sciezka: string) => fileURLToPath(new URL(`../../serwer/src/${sciezka}`, import.meta.url));
const korzen = (sciezka: string) => fileURLToPath(new URL(`../../${sciezka}`, import.meta.url));

function kontekst(scope: Construct, klucz: string): string {
  const w = scope.node.tryGetContext(klucz);
  if (typeof w !== 'string' || w.trim() === '') {
    throw new Error(`Brak kontekstu CDK "${klucz}". Podaj go w wywołaniu: cdk synth -c ${klucz}=<wartość> (albo -c nadawca=... -c emailAlarmow=...).`);
  }
  return w.trim();
}

/** Detail types of Heartwood events handled by `HeartwoodZdarzenia`. */
const TYPY_HEARTWOOD = ['lock.release_requested', 'change.rejected', 'lock.broken', 'quota.near', 'quota.exceeded'];

/** Value of the optional `heartwood` CDK context. */
export interface KontekstHeartwood { intUrl: string; intApiArn: string }

/**
 * Reads the optional `heartwood` context (a JSON string).
 *
 * Call: `kontekstHeartwood(scope)`.
 * Expects: absent/empty, or JSON
 *   `{"intUrl":"https://...","intApiArn":"arn:..."}`.
 * Output: the parsed context, or `undefined` when absent; throws a
 *   Polish error on invalid JSON or missing fields.
 */
export function kontekstHeartwood(scope: Construct): KontekstHeartwood | undefined {
  const w = scope.node.tryGetContext('heartwood');
  if (w === undefined || w === null || (typeof w === 'string' && w.trim() === '')) return undefined;
  const blad = () => new Error('Zły kontekst CDK "heartwood": oczekiwano JSON {"intUrl":"https://...","intApiArn":"arn:aws:execute-api:..."} (np. -c heartwood=\'{...}\').');
  let o: unknown;
  try { o = typeof w === 'string' ? JSON.parse(w) : w; } catch { throw blad(); }
  const { intUrl, intApiArn } = (o ?? {}) as Record<string, unknown>;
  if (typeof intUrl !== 'string' || intUrl.trim() === '' || typeof intApiArn !== 'string' || intApiArn.trim() === '') throw blad();
  return { intUrl: intUrl.trim(), intApiArn: intApiArn.trim() };
}

/** `Nazwa <adres@x>` -> `adres@x` (tożsamość SES to sam adres). */
const adresNadawcy = (nadawca: string) => /<([^>]+)>/.exec(nadawca)?.[1] ?? nadawca;

export class StosCogniFly extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);
    const nadawca = kontekst(this, 'nadawca');
    const emailAlarmow = kontekst(this, 'emailAlarmow');
    const domenaSesRaw = this.node.tryGetContext('domenaSes');
    const heartwood = kontekstHeartwood(this);
    const domenaSes = typeof domenaSesRaw === 'string' && domenaSesRaw.trim() !== '' ? domenaSesRaw.trim() : undefined;

    // --- Dane (odzwierciedla definicjaTabeli() z serwer/src/dane/tabela.ts) ---
    const tabela = new Table(this, 'Tabela', {
      tableName: NAZWA_TABELI,
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'wygasa',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN, // dane przeżywają usunięcie stosu
      ...(heartwood ? { stream: StreamViewType.NEW_AND_OLD_IMAGES } : {}),
    });
    tabela.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'gsi1pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: AttributeType.STRING },
    });

    // --- Szyna zdarzeń ---
    const szyna = new EventBus(this, 'Szyna', { eventBusName: NAZWA_SZYNY });
    szyna.archive('Archiwum', {
      archiveName: `${PREFIKS}-archiwum`,
      description: 'Archiwum wszystkich zdarzeń szyny cognifly-test (30 dni)',
      eventPattern: { account: [this.account] },
      retention: Duration.days(30),
    });

    // --- DLQ: błędy wywołań asynchronicznych (EventBridge i Scheduler wołają Lambdy async) ---
    const dlq = new Queue(this, 'Dlq', {
      queueName: `${PREFIKS}-przetwarzanie-dlq`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const dlqEskalacji = new Queue(this, 'DlqEskalacji', {
      queueName: `${PREFIKS}-eskalacja-dlq`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    // --- Funkcje ---
    const wspolne = (nazwa: string, wejscie: string, env: Record<string, string>, deadLetterQueue?: Queue) => {
      const logi = new LogGroup(this, `${nazwa}Logi`, {
        logGroupName: `/aws/lambda/${PREFIKS}-${nazwa.toLowerCase()}`,
        retention: RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      return new NodejsFunction(this, nazwa, {
        functionName: `${PREFIKS}-${nazwa.toLowerCase()}`,
        entry: serwer(wejscie),
        handler: 'handler',
        projectRoot: korzen(''),
        depsLockFilePath: korzen('package-lock.json'),
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 256,
        timeout: Duration.seconds(30),
        logGroup: logi,
        environment: env,
        ...(deadLetterQueue ? { deadLetterQueue } : {}),
        bundling: {
          format: OutputFormat.ESM,
          target: 'node22',
          minify: false,
          sourceMap: true,
          forceDockerBundling: false,
          mainFields: ['module', 'main'],
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        },
      });
    };

    const webhook = wspolne('Webhook', 'wejscie/github.ts', { COGNIFLY_SZYNA: NAZWA_SZYNY });
    const eskalacja = wspolne('Eskalacja', 'eskalacja/obsluz.ts', {
      COGNIFLY_TABELA: NAZWA_TABELI, COGNIFLY_NADAWCA: nadawca,
    }, dlqEskalacji);
    const api = wspolne('Api', 'api/index.ts', { COGNIFLY_TABELA: NAZWA_TABELI });
    // Nasłuch dostarczeń: ocenia zaakceptowane PR (tylko odczyt GitHuba) i tworzy zadania „Dostarcz”.
    const dostarczenia = wspolne('Dostarczenia', 'dostarczenia/obsluz.ts', { COGNIFLY_TABELA: NAZWA_TABELI });

    // Scheduler: grupa + rola, która może wyłącznie wywołać Lambdę eskalacji.
    const grupa = new CfnScheduleGroup(this, 'GrupaEskalacji', { name: NAZWA_GRUPY });
    const schedulerRola = new Role(this, 'SchedulerRola', {
      roleName: `${PREFIKS}-scheduler`,
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    });
    eskalacja.grantInvoke(schedulerRola);

    const przetwarzanie = wspolne('Przetwarzanie', 'przetwarzanie/obsluz.ts', {
      COGNIFLY_SZYNA: NAZWA_SZYNY,
      COGNIFLY_TABELA: NAZWA_TABELI,
      COGNIFLY_NADAWCA: nadawca,
      COGNIFLY_GRUPA_ESKALACJI: NAZWA_GRUPY,
      COGNIFLY_ESKALACJA_ARN: eskalacja.functionArn,
      COGNIFLY_SCHEDULER_ROLA_ARN: schedulerRola.roleArn,
    }, dlq);

    // --- Uprawnienia (least privilege) ---
    const odczytSekretow = (rodzaj: 'github' | 'discord' | 'github-odczyt') => new PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [this.formatArn({ service: 'secretsmanager', resource: 'secret', resourceName: `${PREFIKS}/${rodzaj}/*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    });
    const wysylkaSes = new PolicyStatement({
      actions: ['ses:SendEmail'],
      // Tożsamość odbiorcy też bywa autoryzowana (sandbox SES), a nadawcą może być domena: zawężamy warunkiem From.
      resources: [this.formatArn({ service: 'ses', resource: 'identity', resourceName: '*', arnFormat: ArnFormat.SLASH_RESOURCE_NAME })],
      conditions: { StringEquals: { 'ses:FromAddress': adresNadawcy(nadawca) } },
    });

    szyna.grantPutEventsTo(webhook);
    webhook.addToRolePolicy(odczytSekretow('github')); // sekret podpisu cognifly-test/github/<firma>

    for (const f of [przetwarzanie, eskalacja, api, dostarczenia]) tabela.grantReadWriteData(f);
    // Token GitHuba tylko do odczytu per firma: cognifly-test/github-odczyt/<firma> (wartość wpisuje admin).
    for (const f of [api, dostarczenia]) f.addToRolePolicy(odczytSekretow('github-odczyt'));
    for (const f of [przetwarzanie, eskalacja]) {
      f.addToRolePolicy(odczytSekretow('discord')); // webhooki Discorda cognifly-test/discord/*
      f.addToRolePolicy(wysylkaSes);
    }
    przetwarzanie.addToRolePolicy(new PolicyStatement({
      actions: ['scheduler:CreateSchedule'],
      resources: [this.formatArn({ service: 'scheduler', resource: 'schedule', resourceName: `${NAZWA_GRUPY}/*`, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })],
    }));
    przetwarzanie.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW, actions: ['iam:PassRole'], resources: [schedulerRola.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
    }));
    przetwarzanie.node.addDependency(grupa);

    // --- Heartwood (tylko z kontekstem `heartwood`):
    //     praca -> rejestr, zdarzenia -> zadania ---
    // Funkcje i kolejka Heartwood trafiają niżej do pętli alarmów.
    const funkcjeHeartwood: Record<string, NodejsFunction> = {};
    const kolejkiHeartwood: Record<string, Queue> = {};
    if (heartwood) {
      const env = { HEARTWOOD_INT_URL: heartwood.intUrl, COGNIFLY_TABELA: NAZWA_TABELI };
      const praca = wspolne('HeartwoodPraca', 'heartwood/strumien.ts', env);
      const zdarzenia = wspolne('HeartwoodZdarzenia', 'heartwood/zdarzenia.ts', { ...env, COGNIFLY_NADAWCA: nadawca });
      const dlqHeartwood = new Queue(this, 'DlqHeartwood', {
        queueName: `${PREFIKS}-heartwood-dlq`,
        retentionPeriod: Duration.days(14),
        enforceSSL: true,
      });
      Object.assign(funkcjeHeartwood, { HeartwoodPraca: praca, HeartwoodZdarzenia: zdarzenia });
      kolejkiHeartwood.Heartwood = dlqHeartwood;
      tabela.grantReadData(praca);
      tabela.grantReadWriteData(zdarzenia);
      zdarzenia.addToRolePolicy(odczytSekretow('discord'));
      zdarzenia.addToRolePolicy(wysylkaSes);
      praca.addToRolePolicy(new PolicyStatement({
        actions: ['execute-api:Invoke'], resources: [`${heartwood.intApiArn}/*/*/int/*`],
      }));
      praca.addEventSource(new DynamoEventSource(tabela, {
        startingPosition: StartingPosition.TRIM_HORIZON,
        reportBatchItemFailures: true, retryAttempts: 10, bisectBatchOnError: true,
        onFailure: new SqsDlq(dlqHeartwood),
      }));
      new Rule(this, 'RegulaHeartwood', {
        ruleName: `${PREFIKS}-heartwood`,
        eventBus: szyna,
        eventPattern: { source: ['heartwood'], detailType: TYPY_HEARTWOOD },
        targets: [new LambdaFunction(zdarzenia, { deadLetterQueue: dlqHeartwood, retryAttempts: 2 })],
      });
    }

    // --- Reguła szyny -> przetwarzanie ---
    new Rule(this, 'RegulaPrzetwarzania', {
      ruleName: `${PREFIKS}-przetwarzanie`,
      eventBus: szyna,
      eventPattern: { source: Match.prefix('cognifly.') as unknown as string[] },
      targets: [new LambdaFunction(przetwarzanie, { deadLetterQueue: dlq, retryAttempts: 2 })],
    });

    // --- Dostarczenia: sygnały z webhooka (osobne źródło, poza potokiem zdarzeń) + przegląd co 10 min ---
    new Rule(this, 'RegulaDostarczen', {
      ruleName: `${PREFIKS}-dostarczenia`,
      eventBus: szyna,
      eventPattern: { source: ['dostarczenia.github'] },
      targets: [new LambdaFunction(dostarczenia, { retryAttempts: 2 })],
    });
    const rolaPrzegladu = new Role(this, 'PrzegladDostarczenRola', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }),
    });
    dostarczenia.grantInvoke(rolaPrzegladu);
    new CfnSchedule(this, 'PrzegladDostarczen', {
      name: `${PREFIKS}-dostarczenia`,
      scheduleExpression: 'rate(10 minutes)',
      flexibleTimeWindow: { mode: 'OFF' },
      target: { arn: dostarczenia.functionArn, roleArn: rolaPrzegladu.roleArn, input: '{}' },
    });

    // --- Cognito ---
    const pula = new UserPool(this, 'Pula', {
      userPoolName: `${PREFIKS}-uzytkownicy`,
      featurePlan: FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      // EMAIL_OTP wymaga wysyłki przez SES (DEVELOPER); nadawca z kontekstu, ta sama tożsamość SES co powiadomienia.
      email: UserPoolEmail.withSES({
        fromEmail: adresNadawcy(nadawca),
        sesRegion: 'eu-central-1',
        ...(domenaSes ? { sesVerifiedDomain: domenaSes } : {}),
      }),
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      autoVerify: { email: true },
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true } },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const klient = new UserPoolClient(this, 'Klient', {
      userPool: pula,
      userPoolClientName: `${PREFIKS}-klient`,
      generateSecret: false,
      disableOAuth: true,
      authFlows: { user: true }, // ALLOW_USER_AUTH (+ ALLOW_REFRESH_TOKEN_AUTH dodawany zawsze)
      preventUserExistenceErrors: true,
    });

    // --- HTTP API ---
    const autoryzator = new HttpJwtAuthorizer('Autoryzator', `https://cognito-idp.${this.region}.${this.urlSuffix}/${pula.userPoolId}`, {
      jwtAudience: [klient.userPoolClientId],
      identitySource: ['$request.header.Authorization'],
    });
    const httpApi = new HttpApi(this, 'HttpApi', {
      apiName: `${PREFIKS}-api`,
      corsPreflight: {
        allowOrigins: ['*'],
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
      },
    });
    httpApi.addRoutes({
      path: '/webhook/github/{firma}',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('WebhookIntegracja', webhook),
    });
    const apiIntegracja = new HttpLambdaIntegration('ApiIntegracja', api);
    for (const [metoda, sciezka] of [
      [HttpMethod.GET, '/zdarzenia'], [HttpMethod.GET, '/skrzynka'], [HttpMethod.GET, '/zadania/{id}'],
      [HttpMethod.POST, '/zadania/{id}/biore'], [HttpMethod.POST, '/zadania/{id}/przekaz'], [HttpMethod.POST, '/zadania/{id}/stan'],
      [HttpMethod.POST, '/zadania/{id}/odrzuc'], [HttpMethod.POST, '/zadania/{id}/usun'], [HttpMethod.POST, '/zadania/{id}/watek'],
      [HttpMethod.POST, '/zadania/{id}/akceptuj'], [HttpMethod.POST, '/zadania/{id}/do-poprawy'],
      [HttpMethod.GET, '/podsumowanie'], [HttpMethod.GET, '/ja'],
      [HttpMethod.POST, '/dostarczenia'], [HttpMethod.GET, '/dostarczenia/ocena'],
      [HttpMethod.GET, '/osoby'], [HttpMethod.POST, '/recenzje'],
    ] as const) {
      httpApi.addRoutes({ path: sciezka, methods: [metoda], integration: apiIntegracja, authorizer: autoryzator });
    }

    // --- Alarmy ---
    const alarmy = new Topic(this, 'Alarmy', { topicName: `${PREFIKS}-alarmy` });
    alarmy.addSubscription(new EmailSubscription(emailAlarmow));
    for (const [nazwa, f] of Object.entries({ Webhook: webhook, Przetwarzanie: przetwarzanie, Eskalacja: eskalacja, Api: api, Dostarczenia: dostarczenia, ...funkcjeHeartwood })) {
      new Alarm(this, `Alarm${nazwa}`, {
        alarmName: `${PREFIKS}-${nazwa.toLowerCase()}-bledy`,
        metric: f.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new SnsAction(alarmy));
    }

    for (const [nazwa, q] of Object.entries({ Przetwarzanie: dlq, Eskalacja: dlqEskalacji, ...kolejkiHeartwood })) {
      new Alarm(this, `AlarmDlq${nazwa}`, {
        alarmName: `${PREFIKS}-${nazwa.toLowerCase()}-dlq`,
        metric: q.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new SnsAction(alarmy));
    }

    // --- Wyjścia ---
    const adresApi = httpApi.apiEndpoint;
    new CfnOutput(this, 'AdresApi', { value: adresApi });
    new CfnOutput(this, 'AdresWebhookGithub', { value: `${adresApi}/webhook/github/{firma}` });
    new CfnOutput(this, 'Region', { value: this.region });
    new CfnOutput(this, 'PulaCognito', { value: pula.userPoolId });
    new CfnOutput(this, 'KlientCognito', { value: klient.userPoolClientId });
    new CfnOutput(this, 'NazwaSzyny', { value: szyna.eventBusName });

    Tags.of(this).add('Project', 'cognifly');
  }
}
