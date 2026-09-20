import { MODEL_CATALOG, PREMIUM_FEATURES, OVERLAYS, LEVELS, LEVEL_ALTITUDE, BASEMAP_STYLES, SUPPORTED_LANGUAGES } from './types';

/** Local reference data, available without network access or credentials. */
export const referenceCatalog = {
  models: MODEL_CATALOG,
  premiumFeatures: PREMIUM_FEATURES,
  overlays: OVERLAYS.map((name) => ({ name })),
  levels: LEVELS.map((level) => ({ level, ...LEVEL_ALTITUDE[level] })),
  basemaps: BASEMAP_STYLES.map((name) => ({ name })),
  languages: SUPPORTED_LANGUAGES.map((name) => ({ name })),
};
