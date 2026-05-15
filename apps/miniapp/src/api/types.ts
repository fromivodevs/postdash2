/**
 * Wire-format types returned by the API.
 *
 * `AuthProjection` and `ApiErrorBody` are re-exported from `@postdash/shared` —
 * the single typed source of truth shared with the API server, so the two
 * sides cannot drift. Import them through this module so app code keeps a
 * stable local path.
 *
 * Channel projections (Phase 2): `ChannelProjection`, `ChannelListProjection`,
 * and `ConnectCodeProjection` come from the same shared package. They are
 * re-exported here for symmetry with the Phase 1 `AuthProjection` import path
 * so any screen-level code only ever reaches one module for wire types.
 */
export type { AuthProjection, ApiErrorBody } from '@postdash/shared';
export type {
  ChannelProjection,
  ChannelListProjection,
  ConnectCodeProjection,
} from '@postdash/shared';
