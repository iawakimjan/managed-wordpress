import {Construct} from 'constructs';
import {Stack, StackProps} from "aws-cdk-lib";
import {InstanceClass, InstanceSize, InstanceType, NatProvider, SubnetType, Vpc} from "aws-cdk-lib/aws-ec2";
import {HostedZone} from "aws-cdk-lib/aws-route53";
import {ManagedWordpress} from "./ManagedWordpress";

export class WordpressStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        // Networking
        const vpc = new Vpc(this, "VPC", {
            maxAzs: 2,
            natGateways: 0,
        });

        // Wordpress infrastructure according to reference architecture
        const hostedZone = HostedZone.fromLookup(this, " HostedZone", {
            domainName: "nopremise.cloud"
        });

        const wordpress = new ManagedWordpress(this, "WebService", {
            vpc,
            hostedZone,
            siteName: "No Premise Cloud",
            imageVersion: "6.1.1",
            db: {
                secretName: "planetscape-mysql"
            },
            size: {
                memory: 512,
                cpu: 256,
            },
            scaling: {
                min: 1,
                max: 2,
            }
        });
    }
}
