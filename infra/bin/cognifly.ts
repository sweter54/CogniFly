#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { StosCogniFly } from '../lib/stos.js';

const app = new App();
new StosCogniFly(app, 'cognifly-test', {
  env: { account: '167702900577', region: 'eu-central-1' },
  description: 'CogniFly: środowisko testowe',
});
