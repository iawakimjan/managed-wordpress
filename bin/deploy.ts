#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {WordpressStack} from "../lib/wordpress-stack";

const app = new cdk.App();

new WordpressStack(app, 'Wordpress', {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION
    },
});
