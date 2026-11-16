import { fileURLToPath } from 'node:url';
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { AccountRecovery, FeaturePlan, UserPool, UserPoolEmail, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { EventBus, Match, Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
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

/** `Nazwa <adres@x>` -> `adres@x` (tożsamość SES to sam adres). */
const adresNadawcy = (nadawca: string) => /<([^>]+)>/.exec(nadawca)?.[1] ?? nadawca;

export class StosCogniFly extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);
    const nadawca = kontekst(this, 'nadawca');
    const emailAlarmow = kontekst(this, 'emailAlarmow');
    const domenaSesRaw = this.node.tryGetContext('domenaSes');
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
    const odczytSekretow = (rodzaj: 'github' | 'discord') => new PolicyStatement({
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

    for (const f of [przetwarzanie, eskalacja, api]) tabela.grantReadWriteData(f);
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

    // --- Reguła szyny -> przetwarzanie ---
    new Rule(this, 'RegulaPrzetwarzania', {
      ruleName: `${PREFIKS}-przetwarzanie`,
      eventBus: szyna,
      eventPattern: { source: Match.prefix('cognifly.') as unknown as string[] },
      targets: [new LambdaFunction(przetwarzanie, { deadLetterQueue: dlq, retryAttempts: 2 })],
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
      [HttpMethod.POST, '/zadania/{id}/biore'], [HttpMethod.POST, '/zadania/{id}/stan'],
      [HttpMethod.GET, '/podsumowanie'],
    ] as const) {
      httpApi.addRoutes({ path: sciezka, methods: [metoda], integration: apiIntegracja, authorizer: autoryzator });
    }

    // --- Alarmy ---
    const alarmy = new Topic(this, 'Alarmy', { topicName: `${PREFIKS}-alarmy` });
    alarmy.addSubscription(new EmailSubscription(emailAlarmow));
    for (const [nazwa, f] of Object.entries({ Webhook: webhook, Przetwarzanie: przetwarzanie, Eskalacja: eskalacja, Api: api })) {
      new Alarm(this, `Alarm${nazwa}`, {
        alarmName: `${PREFIKS}-${nazwa.toLowerCase()}-bledy`,
        metric: f.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new SnsAction(alarmy));
    }

    for (const [nazwa, q] of Object.entries({ Przetwarzanie: dlq, Eskalacja: dlqEskalacji })) {
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
