/**
 * Routed app shell — rendered only once the session is `ready` (§8).
 *
 * Owns the wouter <Switch> route table (§10) and the bottom <AppTabBar>. The
 * Tabbar is hidden on /onboarding so the wizard gets the full screen (§9, §7).
 *
 * The boot-time deep-link (§10 step 1-2) is applied in main.tsx BEFORE the
 * router's first render — see routing/applyDeepLink.ts — so this shell never
 * has to navigate post-paint.
 *
 * Session state branching (pending / error / no-telegram) stays in App.tsx —
 * this component assumes a live session.
 */

import { Route, Switch, useLocation } from 'wouter';
import { AppTabBar } from './components/AppTabBar.tsx';
import { ROUTES } from './routing/routes.ts';
import { RadarScreen } from './screens/RadarScreen.tsx';
import { NewsDetailScreen } from './screens/NewsDetailScreen.tsx';
import { DraftsScreen } from './screens/DraftsScreen.tsx';
import { DraftDetailScreen } from './screens/DraftDetailScreen.tsx';
import { SourcesScreen } from './screens/SourcesScreen.tsx';
import { AddSourceScreen } from './screens/AddSourceScreen.tsx';
import { ChannelScreen } from './screens/ChannelScreen.tsx';
import { SettingsScreen } from './screens/SettingsScreen.tsx';
import { OnboardingScreen } from './screens/onboarding/OnboardingScreen.tsx';

export function AppShell() {
  const [location] = useLocation();
  const showTabBar = location !== ROUTES.onboarding;

  return (
    <div className={showTabBar ? 'app-shell' : 'app-shell app-shell--no-tabbar'}>
      <Switch>
        <Route path="/" component={RadarScreen} />
        {/* Param route before the Radar root so /radar/<id> news deep-links resolve. */}
        <Route path={`${ROUTES.radar}/:matchId`} component={NewsDetailScreen} />
        <Route path={ROUTES.radar} component={RadarScreen} />
        {/* Param route before the list route so draft_<id> deep-links resolve. */}
        <Route path={`${ROUTES.drafts}/:draftId`} component={DraftDetailScreen} />
        <Route path={ROUTES.drafts} component={DraftsScreen} />
        {/* Specific /sources/new before the /sources list (§10 route table). */}
        <Route path={`${ROUTES.sources}/new`} component={AddSourceScreen} />
        <Route path={ROUTES.sources} component={SourcesScreen} />
        {/* /channel also serves connect_<code> deep-links via the ?code= query. */}
        <Route path={ROUTES.channel} component={ChannelScreen} />
        <Route path={ROUTES.settings} component={SettingsScreen} />
        <Route path={ROUTES.onboarding} component={OnboardingScreen} />
        {/* Unknown path -> Radar (default tab, §10). */}
        <Route component={RadarScreen} />
      </Switch>
      {showTabBar && <AppTabBar />}
    </div>
  );
}
