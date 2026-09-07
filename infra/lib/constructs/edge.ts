import * as cdk from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
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
  /**
   * Custom viewer domain (e.g. `clawd-game.whchoi.net`). Requires `certificate`.
   * DNS for the name is managed outside this stack (a CNAME to the distribution).
   */
  readonly domainName?: string;
  /** ACM certificate covering `domainName`; CloudFront requires it to live in us-east-1. */
  readonly certificate?: acm.ICertificate;
}

/**
 * Content-Security-Policy served at the edge. Only Google Fonts is allowed
 * off-origin (the UI webfont is the single external fetch); no wildcards.
 * The client writes styles through the CSSOM (not blocked by CSP) and spawns
 * no blob: workers, so neither 'unsafe-inline' nor blob: is granted.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Longest the edge may keep one leaderboard page; the origin asks for s-maxage=5 (src/server/routes/leaderboard.ts). */
export const LEADERBOARD_EDGE_MAX_TTL_SECONDS = 60;
/** Path pattern of the one cacheable API behaviour; must precede `/api/*` in the behaviour order. */
export const LEADERBOARD_PATH_PATTERN = '/api/leaderboard*';

/**
 * CloudFront in front of the ALB. HTTP only to the origin (the SG and header
 * rule, not TLS, gate the ALB); HTTPS enforced for viewers.
 *
 *  - `/assets/*`           hashed immutable files → CACHING_OPTIMIZED
 *  - `/api/leaderboard*`   the public top-N (P3-12): honours the origin's
 *                          `s-maxage=5, stale-while-revalidate=30` up to 60 s,
 *                          keyed by the full query string, gzip/br in the key
 *                          so the edge may compress; GET/HEAD only
 *  - `/api/*`              never cached, all methods, full viewer request forwarded
 *  - default               index.html and friends: honour origin Cache-Control (min TTL 0)
 */
export class Edge extends Construct {
  readonly distribution: cloudfront.Distribution;
  readonly responseHeadersPolicy: cloudfront.ResponseHeadersPolicy;
  readonly htmlCachePolicy: cloudfront.CachePolicy;
  readonly leaderboardCachePolicy: cloudfront.CachePolicy;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);
    if (!!props.domainName !== !!props.certificate) {
      throw new Error('Edge: domainName and certificate must be given together');
    }

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

    // The leaderboard is the same JSON for every viewer, so it may live at the
    // edge for the few seconds the origin allows: TTL 0/0/60 lets the origin's
    // s-maxage decide (and nothing without one is kept), the query string is the
    // key (mode, board, limit), no headers or cookies, and gzip/br in the key so
    // CloudFront may cache and serve compressed variants.
    this.leaderboardCachePolicy = new cloudfront.CachePolicy(this, 'LeaderboardCache', {
      comment: 'Public leaderboard pages: honour origin s-maxage up to 60 s, key on the query string',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(LEADERBOARD_EDGE_MAX_TTL_SECONDS),
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
        // Behaviours are matched in this order: the leaderboard must come before the /api/* catch-all.
        [LEADERBOARD_PATH_PATTERN]: {
          origin,
          viewerProtocolPolicy: viewer,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: this.leaderboardCachePolicy,
          // Same viewer forwarding as the rest of the API (the server still rate-limits on CloudFront-Viewer-Address).
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022,
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
          // CloudFront only compresses when the cache policy enables gzip/brotli
          // in the cache key, which CACHING_DISABLED does not, so `compress`
          // would be a no-op here (CDK defaults it to true). API responses are
          // compressed at the origin instead (@fastify/compress).
          compress: false,
        },
      },
      // Error caching TTL 0 for 404/403 and no custom page: during a rolling
      // deploy a hashed asset requested from a task still on the old image
      // 404s, and CloudFront must not pin that answer for its default 10 s.
      // The status reaches the client unchanged.
      errorResponses: [
        { httpStatus: 404, ttl: cdk.Duration.seconds(0) },
        { httpStatus: 403, ttl: cdk.Duration.seconds(0) },
      ],
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      // Custom domain: SNI-only with the ACM certificate; without one CloudFront
      // serves *.cloudfront.net and a CNAME to it fails certificate validation.
      ...(props.domainName && props.certificate
        ? {
            domainNames: [props.domainName],
            certificate: props.certificate,
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            sslSupportMethod: cloudfront.SSLMethod.SNI,
          }
        : {}),
    });
  }
}
