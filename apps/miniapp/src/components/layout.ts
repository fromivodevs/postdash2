/**
 * Layout primitives — stable re-exports of telegram-ui's layout kit (§3).
 *
 * Screens import Section/Cell/List/Spinner/Placeholder/Button from here, not
 * straight from '@telegram-apps/telegram-ui'. One indirection means if we ever
 * need to wrap or swap a primitive (theming, a11y shim, kit upgrade) we change
 * one file instead of every screen.
 */

export {
  Section,
  Cell,
  List,
  Spinner,
  Placeholder,
  Button,
  Banner,
} from '@telegram-apps/telegram-ui';
