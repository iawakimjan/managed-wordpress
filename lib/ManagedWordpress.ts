import {Construct} from "constructs";
import {IVpc, Port, SubnetType} from "aws-cdk-lib/aws-ec2";
import {DatabaseSecret} from "aws-cdk-lib/aws-rds";
import {
    Cluster,
    Compatibility,
    ContainerImage,
    FargateService,
    LogDriver,
    Secret,
    TaskDefinition
} from "aws-cdk-lib/aws-ecs";
import {PolicyStatement} from "aws-cdk-lib/aws-iam";
import {ApplicationLoadBalancedFargateService} from "aws-cdk-lib/aws-ecs-patterns";
import {ARecord, IHostedZone, RecordTarget} from "aws-cdk-lib/aws-route53";
import {
    ApplicationListener,
    ApplicationListenerRule,
    ApplicationLoadBalancer,
    ApplicationProtocol,
    ApplicationTargetGroup,
    ListenerAction,
    ListenerCondition
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {RetentionDays} from "aws-cdk-lib/aws-logs";
import {AccessPoint, FileSystem, PerformanceMode, ThroughputMode} from "aws-cdk-lib/aws-efs";
import {
    AllowedMethods,
    CachePolicy,
    Distribution,
    OriginProtocolPolicy, OriginRequestHeaderBehavior, OriginRequestPolicy, OriginRequestQueryStringBehavior,
    PriceClass,
    ViewerProtocolPolicy
} from "aws-cdk-lib/aws-cloudfront";
import {LoadBalancerV2Origin} from "aws-cdk-lib/aws-cloudfront-origins";
import {DnsValidatedCertificate} from "aws-cdk-lib/aws-certificatemanager";
import {CloudFrontTarget} from "aws-cdk-lib/aws-route53-targets";
import {Duration} from "aws-cdk-lib";

const CONTAINER_PORT = 8080;
const SCALE_PERCENT = 90;

export interface ManagedWordpressProps {
    siteName: string;
    hostedZone: IHostedZone;
    vpc: IVpc;
    db: {
        secretName: string;
    }
    size: {
        memory: number;
        cpu: number;
    }
    scaling: {
        min: number;
        max: number;
    };
    imageVersion: string;
    databaseName?: string;
}

export class ManagedWordpress extends Construct {
    public service: ApplicationLoadBalancedFargateService;

    constructor(scope: Construct, id: string, props: ManagedWordpressProps) {
        super(scope, id);

        const efs = new FileSystem(this, "PersistentStorage", {
            vpc: props.vpc,
            enableAutomaticBackups: true,
            encrypted: true,
            performanceMode: PerformanceMode.GENERAL_PURPOSE,
            throughputMode: ThroughputMode.ELASTIC,
            vpcSubnets: {
                subnetType: SubnetType.PRIVATE_ISOLATED
            },
        });

        const accessPoint = new AccessPoint(this, "PersistentStorageAccessPoint", {
            fileSystem: efs,
            path: "/wordpress",
            createAcl: {
                ownerUid: "1001",
                ownerGid: "0",
                permissions: "0755",
            },
            posixUser: {
                uid: "1001",
                gid: "0"
            }
        });

        const taskDefinition = new TaskDefinition(this, "TaskDefinition", {
            compatibility: Compatibility.FARGATE,
            memoryMiB: props.size.memory.toString(),
            cpu: props.size.cpu.toString(),
        });

        const databaseSecret = DatabaseSecret.fromSecretNameV2(this, "DatabaseSecret", props.db.secretName);

        const container = taskDefinition.addContainer("WebContainer", {
            image: ContainerImage.fromRegistry(`bitnami/wordpress:${props.imageVersion}`),
            logging: LogDriver.awsLogs({
                streamPrefix: "/ecs/Wordpress",
                logRetention: RetentionDays.ONE_WEEK,
            }),
            environment: {
                MYSQL_CLIENT_ENABLE_SSL: "yes",
                WORDPRESS_ENABLE_DATABASE_SSL: "yes",
                WORDPRESS_EXTRA_WP_CONFIG_CONTENT: "define('FORCE_SSL_ADMIN', true); $_SERVER['HTTPS']='on';",
            },
            secrets: {
                WORDPRESS_DATABASE_NAME: Secret.fromSecretsManager(databaseSecret, 'dbname'),
                WORDPRESS_DATABASE_HOST: Secret.fromSecretsManager(databaseSecret, 'host'),
                WORDPRESS_DATABASE_PORT_NUMBER: Secret.fromSecretsManager(databaseSecret, 'port'),
                WORDPRESS_DATABASE_USER: Secret.fromSecretsManager(databaseSecret, 'username'),
                WORDPRESS_DATABASE_PASSWORD: Secret.fromSecretsManager(databaseSecret, 'password'),
            }
        });

        const volumeName = "wp-vol";
        taskDefinition.addVolume({
            name: volumeName,
            efsVolumeConfiguration: {
                fileSystemId: efs.fileSystemId,
                transitEncryption: "ENABLED",
                authorizationConfig: {
                    accessPointId: accessPoint.accessPointId,
                    iam: "ENABLED",
                }
            },
        });

        taskDefinition.defaultContainer?.addMountPoints({
            containerPath: "/bitnami/wordpress",
            readOnly: false,
            sourceVolume: volumeName,
        });

        taskDefinition.addToTaskRolePolicy(
            new PolicyStatement({
                actions: [
                    "elasticfilesystem:ClientRootAccess",
                    "elasticfilesystem:ClientWrite",
                    "elasticfilesystem:ClientMount",
                    "elasticfilesystem:DescribeMountTargets"
                ],
                resources: [efs.fileSystemArn]
            })
        );

        taskDefinition.addToTaskRolePolicy(
            new PolicyStatement({
                actions: ["secretsmanager:GetSecretValue"],
                resources: [databaseSecret.secretArn],
            })
        );

        taskDefinition.defaultContainer?.addPortMappings({
            containerPort: CONTAINER_PORT,
            hostPort: CONTAINER_PORT,
        });

        const loadBalancer = new ApplicationLoadBalancer(this, "LoadBalancer", {
            vpc: props.vpc,
            internetFacing: true,
            vpcSubnets: {
                subnetType: SubnetType.PUBLIC
            }
        });

        const cluster = new Cluster(this, "Cluster", {
            vpc: props.vpc,
        });

        const service = new FargateService(this, "ContainerService", {
            cluster: cluster,
            taskDefinition: taskDefinition,
            assignPublicIp: true,
            desiredCount: 1,
            vpcSubnets: {
                subnetType: SubnetType.PUBLIC,
            },

            minHealthyPercent: 50,
            maxHealthyPercent: 200,

            circuitBreaker: {
                rollback: true,
            },
        });
        efs.connections.allowDefaultPortFrom(service.connections);

        const targetGroup = new ApplicationTargetGroup(this, "TargetGroup", {
            port: CONTAINER_PORT,
            protocol: ApplicationProtocol.HTTP,
            deregistrationDelay: Duration.seconds(5),
            vpc: props.vpc,
            targets: [service.loadBalancerTarget({
                containerName: container.containerName,
                containerPort: CONTAINER_PORT
            })],
            healthCheck: {
                path: "/",
                port: CONTAINER_PORT.toString(),
                healthyHttpCodes: "200",
                interval: Duration.seconds(5),
                timeout: Duration.seconds(2),
                healthyThresholdCount: 2,
            },
        });

        const listener = new ApplicationListener(this, "Listener", {
            defaultAction: ListenerAction.fixedResponse(403, {messageBody: "Access Denied"}),
            loadBalancer: loadBalancer,
            open: true,
            port: 80,
        });

        new ApplicationListenerRule(this, "ListenerRule", {
            listener: listener,
            priority: 1,
            targetGroups: [targetGroup],
            conditions: [
                ListenerCondition.httpHeader("X-Custom-Header", [databaseSecret.secretValueFromJson("loadbalancer").unsafeUnwrap()]),
            ]
        });

        const scaling = service.autoScaleTaskCount({
            minCapacity: props.scaling.min,
            maxCapacity: props.scaling.max,
        });

        scaling.scaleOnCpuUtilization("cpu", {
            targetUtilizationPercent: SCALE_PERCENT,
        });

        scaling.scaleOnMemoryUtilization("memory", {
            targetUtilizationPercent: SCALE_PERCENT,
        });

        const certificate = new DnsValidatedCertificate(this, "Certificate", {
            domainName: props.hostedZone.zoneName,
            hostedZone: props.hostedZone,
            region: "us-east-1",
        });

        const distribution = new Distribution(this, "CDN", {
            certificate,
            domainNames: [props.hostedZone.zoneName],
            priceClass: PriceClass.PRICE_CLASS_100,
            defaultBehavior: {
                origin: new LoadBalancerV2Origin(loadBalancer, {
                    protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
                    customHeaders: {"X-Custom-Header": databaseSecret.secretValueFromJson("loadbalancer").unsafeUnwrap()}
                }),
                allowedMethods: AllowedMethods.ALLOW_ALL,
                cachePolicy: CachePolicy.CACHING_DISABLED,
                viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
            },
            additionalBehaviors: {
                "wp-includes/*": {
                    origin: new LoadBalancerV2Origin(loadBalancer, {
                        protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
                        customHeaders: {"X-Custom-Header": databaseSecret.secretValueFromJson("loadbalancer").unsafeUnwrap()}
                    }),
                    allowedMethods: AllowedMethods.ALLOW_ALL,
                    cachePolicy: CachePolicy.CACHING_OPTIMIZED,
                    viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    originRequestPolicy: new OriginRequestPolicy(this, "Limited", {
                        queryStringBehavior: OriginRequestQueryStringBehavior.all(),
                        headerBehavior: OriginRequestHeaderBehavior.allowList("Host")
                    }),
                }
            }
        });

        new ARecord(this, "DomainARecord", {
            recordName: props.hostedZone.zoneName,
            target: RecordTarget.fromAlias(new CloudFrontTarget(distribution)),
            zone: props.hostedZone,
        });
    }
}
