/** Routes of the Edit Site custom image size dialog: `csettings.loadcustomimages` (list, save, delete) and `csettings.loadcustomimage`. */
import {
  AuthDenial,
  Roles,
  assertSiteMatches,
  type Opt2AuthContext,
  type Opt2RouteConfig,
  type UserClaims,
} from '@opt2/platform/auth';
import { legacyParamsOf, z, type FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import { toImageSize, type ImageSizesDomain } from '../domain/image-sizes.js';
import type { components } from '../generated/openapi.js';
import { legacyParamsGuard } from './legacy-params.js';

type ImageSize = components['schemas']['ImageSize'];
type ImageSizeList = components['schemas']['ImageSizeList'];
type ImageSizeInput = components['schemas']['ImageSizeInput'];

/** The database and image size operations the routes delegate to. */
export interface ImageSizeRouteDeps {
  db: TenantDb;
  imageSizes: ImageSizesDomain;
}

interface SiteParams {
  siteId: string;
}

interface SizeParams extends SiteParams {
  sizeId: string;
}

const SITE_SIZES_PATH = '/v1/sites/:siteId/image-sizes';
const SIZE_PATH = `${SITE_SIZES_PATH}/:sizeId`;

// csettings.before() admits S2 or an Admin of the site's private user pool (csettings.cfc:85-94); the dialog checks no CSRF token.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([Roles.s2, Roles.siteAdmin]) });

/** Path bounds of `SiteId` and `SizeId`. */
const SIZE_PARAMS_SCHEMA = {
  type: 'object',
  required: ['siteId', 'sizeId'],
  properties: {
    siteId: { type: 'string', minLength: 1, maxLength: 25 },
    sizeId: { type: 'string', minLength: 1, maxLength: 35 },
  },
} as const;

/** `ImageSizeInput` over lower-cased names; `name` length counts code points, as JSON Schema `maxLength` does. */
const validateSizeForm = legacyParamsGuard(
  z.looseObject({ name: z.string().refine((name) => [...name].length <= 50), height: z.string(), width: z.string() }),
);

/** The verified user claims, once `siteId` is confirmed to be the token's site (403 otherwise). */
function siteClaims(auth: Opt2AuthContext, siteId: string): UserClaims {
  const claims = auth.user;
  if (claims === undefined) {
    throw AuthDenial.unauthenticated('missing-credential');
  }
  assertSiteMatches(siteId, claims);
  return claims;
}

/** Registers `listImageSizes`, `getImageSize`, `saveImageSize` and `deleteImageSize`. */
export async function registerImageSizeRoutes(app: FastifyInstance, deps: ImageSizeRouteDeps): Promise<void> {
  const { db, imageSizes } = deps;

  /** The site's sizes as the fragment lists them (loadcustomimages.cfm:14). */
  async function siteSizes(claims: UserClaims, siteId: string): Promise<ImageSizeList> {
    return (await imageSizes.listImageSizes(db, claims, siteId)).map(toImageSize);
  }

  /** `listImageSizes`: the site's custom image sizes. */
  app.get<{ Params: SiteParams; Reply: ImageSizeList }>(SITE_SIZES_PATH, { config: { opt2: ROUTE_AUTH } }, async (request) => {
    const { siteId } = request.params;
    return siteSizes(siteClaims(request.opt2Auth, siteId), siteId);
  });

  /** `getImageSize`: `loadBy(sizeid)`, an unknown id answering the defaulted new size (loadcustomimage.cfm:2). */
  app.get<{ Params: SizeParams; Reply: ImageSize }>(SIZE_PATH, { config: { opt2: ROUTE_AUTH } }, async (request) => {
    const { siteId, sizeId } = request.params;
    return toImageSize(await imageSizes.loadImageSize(db, siteClaims(request.opt2Auth, siteId), sizeId));
  });

  /** `saveImageSize`: `loadBy(sizeid).set(rc).save()`, then the site's sizes (loadcustomimages.cfm:8-9). */
  app.put<{ Params: SizeParams; Body: ImageSizeInput; Reply: ImageSizeList }>(
    SIZE_PATH,
    { config: { opt2: ROUTE_AUTH }, schema: { params: SIZE_PARAMS_SCHEMA }, preHandler: validateSizeForm },
    async (request) => {
      const { siteId, sizeId } = request.params;
      const claims = siteClaims(request.opt2Auth, siteId);
      // set(rc) reads the merged url and form scope; the path ids follow it, so they win over a posted siteid or sizeid.
      await imageSizes.saveImageSize(db, claims, { ...legacyParamsOf(request), siteId, sizeId });
      return siteSizes(claims, siteId);
    },
  );

  /** `deleteImageSize`: `loadBy(sizeid).delete()`, a no-op for an unknown id, then the site's sizes (loadcustomimages.cfm:5-6). */
  app.delete<{ Params: SizeParams; Reply: ImageSizeList }>(SIZE_PATH, { config: { opt2: ROUTE_AUTH } }, async (request) => {
    const { siteId, sizeId } = request.params;
    const claims = siteClaims(request.opt2Auth, siteId);
    await imageSizes.deleteImageSize(db, claims, sizeId);
    return siteSizes(claims, siteId);
  });
}
