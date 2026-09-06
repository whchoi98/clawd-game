import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface EdgeProps {
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  /** Header name the ALB listener rule checks. */
  readonly originVerifyHeader: string;
  /** Token as a CloudFormation dynamic reference (never plaintext). */
  readonly originVerifyValue: string;
}

/**
 * Content-Security-Policy served at the edge. Only Google Fonts is allowed
 * off-origin (the UI webfont is the single external fetch); no wildcards.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * CloudFront in front of the ALB. HTTP only to the origin (the SG and header
 * rule, not TLS, gate the ALB); HTTPS enforced for viewers.
 *
 *  - `/assets/*`  hashed immutable files → CACHING_OPTIMIZED
 *  - `/api/*`     never cached, all methods, full viewer request forwarded
 *  - default      index.html and friends: honour origin Cache-Control (min TTL 0)
 */
export class Edge extends Construct {
  readonly distribution: cloudfront.Distribution;
  readonly responseHeadersPolicy: cloudfront.ResponseHeadersPolicy;
  readonly htmlCachePolicy: cloudfront.CachePolicy;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);

    const origin = new origins.HttpOrigin(props.loadBalancer.loadBalancerDnsName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      customHeaders: { [props.originVerifyHeader]: props.originVerifyValue },
      readTimeout: cdk.Duration.seconds(30),
      keepaliveTimeout: cdk.Duration.seconds(30),
    });

    this.responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      comment: 'CLAWD ECHO TOWER security headers',
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: CONTENT_SECURITY_POLICY, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
      },
    });

    // Cache what the origin says is cacheable, and nothing it does not:
    // index.html is `no-cache`, so it is always revalidated.
    this.htmlCachePolicy = new cloudfront.CachePolicy(this, 'HtmlCache', {
      comment: 'Honour origin Cache-Control; vary on query string only',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.days(1),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const viewer = cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS;

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'CLAWD JUMP: ECHO TOWER',
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: viewer,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: this.htmlCachePolicy,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: this.responseHeadersPolicy,
        compress: true,
      },
      additionalBehaviors: {
        '/assets/*': {
          origin,
          viewerProtocolPolicy: viewer,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: this.responseHeadersPolicy,
          compress: true,
        },
        '/api/*': {
          origin,
          viewerProtocolPolicy: viewer,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Adds CloudFront-Viewer-Address so the server rate-limits on the real
          // viewer IP instead of a client-spoofable X-Forwarded-For hop.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022,
          responseHeadersPolicy: this.responseHeadersPolicy,
          compress: true,
        },
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });
  }
}
