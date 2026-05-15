/**
 * Bottom tab navigation (§7 navigation, §10 routes).
 *
 * The five root tabs (Радар / Черновики / Источники / Канал / Настройки) on
 * telegram-ui's <Tabbar>. The caller (App.tsx) is responsible for NOT rendering
 * this on /onboarding — the wizard owns the full screen there (§9).
 *
 * Tab definitions come from routing/routes.ts so the route table and the nav
 * never drift apart.
 */

import { Tabbar } from '@telegram-apps/telegram-ui';
import { useLocation } from 'wouter';
import { TAB_DEFS, ROUTES } from '../routing/routes.ts';
import { TabIcon } from './tabIcons.tsx';

export function AppTabBar() {
  const [location, navigate] = useLocation();
  // "/" resolves to Radar, so highlight the Radar tab there too.
  const active = location === '/' ? ROUTES.radar : location;

  return (
    <div className="app-tabbar">
      <Tabbar>
        {TAB_DEFS.map((tab) => (
          <Tabbar.Item
            key={tab.path}
            text={tab.label}
            // Explicit accessible name — don't rely on telegram-ui internals to
            // derive it from the (aria-hidden) icon slot.
            aria-label={tab.label}
            selected={active === tab.path}
            onClick={() => navigate(tab.path)}
          >
            {/* One distinct currentColor glyph per tab so the tabs are
                visually separable, not five identical text-only items. The
                Tabbar.Item itself owns the ≥44px tap target. */}
            <TabIcon path={tab.path} />
          </Tabbar.Item>
        ))}
      </Tabbar>
    </div>
  );
}
