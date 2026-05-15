/**
 * Wire-format types returned by the API.
 *
 * `AuthProjection` and `ApiErrorBody` are re-exported from `@postdash/shared` —
 * the single typed source of truth shared with the API server, so the two
 * sides cannot drift. Import them through this module so app code keeps a
 * stable local path.
 */
export type { AuthProjection, ApiErrorBody } from '@postdash/shared';
