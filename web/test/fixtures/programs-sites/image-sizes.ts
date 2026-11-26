import type { components, operations } from '@/generated/clients/programs-sites';
import { SITE_IDS } from './sites';

type ImageSize = components['schemas']['ImageSize'];
type SiteDetail = components['schemas']['SiteDetail'];
type ListImageSizesResponse = operations['listImageSizes']['responses'][200]['content']['application/json'];
type GetImageSizeResponse = operations['getImageSize']['responses'][200]['content']['application/json'];
type SaveImageSizeResponse = operations['saveImageSize']['responses'][200]['content']['application/json'];
type DeleteImageSizeResponse = operations['deleteImageSize']['responses'][200]['content']['application/json'];
type BuiltInImageSizes = Pick<
  SiteDetail['site'],
  | 'smallImageHeight'
  | 'smallImageWidth'
  | 'mediumImageHeight'
  | 'mediumImageWidth'
  | 'largeImageHeight'
  | 'largeImageWidth'
  | 'gallerySmallScaleBy'
  | 'gallerySmallScale'
  | 'galleryMediumScaleBy'
  | 'galleryMediumScale'
  | 'galleryMainScaleBy'
  | 'galleryMainScale'
>;

export const BUILT_IN_IMAGE_SIZES: BuiltInImageSizes = Object.freeze({
  smallImageHeight: '80',
  smallImageWidth: '80',
  mediumImageHeight: '180',
  mediumImageWidth: '180',
  largeImageHeight: 'AUTO',
  largeImageWidth: '600',
  gallerySmallScaleBy: 's',
  gallerySmallScale: 100,
  galleryMediumScaleBy: 'y',
  galleryMediumScale: 250,
  galleryMainScaleBy: 'y',
  galleryMainScale: 500,
});

export const IMAGE_SIZE_IDS = Object.freeze({
  heroBanner: 'C3D4E5F6-A7B8-4C9D-8E0F1A2B3C4D5E6F',
} as const);

export const customImageSizeHeroBanner: ImageSize = Object.freeze({
  sizeID: IMAGE_SIZE_IDS.heroBanner,
  siteID: SITE_IDS.tenantA,
  name: 'hero-banner',
  height: '400',
  width: '1200',
  isNew: 0,
});

export const customImageSizeHeroBannerSaved: ImageSize = Object.freeze({
  ...customImageSizeHeroBanner,
  width: '1280',
});

export const IMAGE_SIZE_LIST_TENANT_A: ListImageSizesResponse = [customImageSizeHeroBanner];

export const IMAGE_SIZE_LIST_TENANT_A_SAVED: ListImageSizesResponse = [customImageSizeHeroBannerSaved];

export const IMAGE_SIZE_LIST_EMPTY: ListImageSizesResponse = [];

export const GET_IMAGE_SIZE_HERO_BANNER: GetImageSizeResponse = customImageSizeHeroBanner;

export const SAVE_IMAGE_SIZE_RESULT: SaveImageSizeResponse = [customImageSizeHeroBannerSaved];

export const DELETE_IMAGE_SIZE_RESULT: DeleteImageSizeResponse = [];
