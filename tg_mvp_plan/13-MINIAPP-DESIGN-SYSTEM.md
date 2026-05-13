# Mini App: Design System, Stack, Performance, Accessibility

Этот документ описывает **как** выглядит и работает Mini App.

Что **есть** на каждом экране — описано в `04-TELEGRAM-BOT-AND-MINIAPP-UX.md`.

## 1. Tech stack (зафиксировано)

- **Framework**: Vite + React 18 + TypeScript (strict mode).
- **Telegram SDK**: `@telegram-apps/sdk-react` (новый официальный, 2024+; не путать со старым `@twa-dev/sdk`).
- **UI components**: `@telegram-apps/telegram-ui` (официальный Telegram UI-kit; нативный look, dark/light auto, готовые `Section`, `Cell`, `Button`, `List`, `Modal`, `Spinner`).
- **State**: React Query (TanStack Query) для server state, Zustand для client state. Никакого Redux.
- **Routing**: `wouter` (~1.5KB) для client-side. Минимальный API, достаточный для 5 tabs + detail screens.
- **Forms**: react-hook-form + zod.
- **Animations**: CSS transitions для всего, кроме editor-version-swipe и confirm-modal (там — `framer-motion`).
- **HTTP**: native `fetch` + retry-wrapper в `packages/shared/api-client.ts`.

**Что НЕ используем**: Next.js (over-engineering для embedded webview), Tailwind (Telegram UI kit имеет свой токен-слой; не плодим стили), Material UI / shadcn (чужой look не подходит к Telegram chrome).

## 2. Design tokens

Используем Telegram theme variables как primary source через `WebApp.themeParams`:

```text
--tg-theme-bg-color
--tg-theme-text-color
--tg-theme-hint-color
--tg-theme-link-color
--tg-theme-button-color
--tg-theme-button-text-color
--tg-theme-secondary-bg-color
--tg-theme-header-bg-color
--tg-theme-accent-text-color
--tg-theme-section-bg-color
--tg-theme-section-header-text-color
--tg-theme-subtitle-text-color
--tg-theme-destructive-text-color
```

Theme автоматически меняется на light/dark по системе пользователя. **Никогда не хардкодим цвета**.

### Spacing scale (4px base)

```text
--space-0:  0
--space-1:  4px
--space-2:  8px
--space-3: 12px
--space-4: 16px   (base padding)
--space-5: 20px
--space-6: 24px
--space-8: 32px
--space-10: 40px
```

### Typography scale

Используем Telegram UI kit-defaults (`Title`, `LargeTitle`, `Headline`, `Subheadline`, `Text`, `Caption`). Без custom fonts.

- font-family: `var(--tgui--font_family)` (наследует системный шрифт устройства);
- никаких web-fonts (увеличивают TTI и не сочетаются с native chrome).

### Радиусы

```text
--radius-sm:  8px   (badges, chips)
--radius-md: 12px   (cards, buttons)
--radius-lg: 16px   (modals, sheets)
```

### Тени

Используем Telegram UI kit defaults. Кастомные тени не добавляем.

### Accent colors (semantic)

```text
--color-success: #34C759   (score 7+, status published)
--color-warning: #FF9500   (score 5–7, status pending)
--color-danger:  #FF3B30   (errors, destructive)
--color-info:    var(--tg-theme-button-color)
```

Все остальное — через Telegram theme tokens.

## 3. Component inventory

Базовая палитра компонентов (на Telegram UI kit):

- **Layout**: `Section`, `Cell`, `List`, `Card` (наш wrapper).
- **Buttons**: `Button` (primary/secondary/outline), `IconButton`, `Chip`.
- **Forms**: `Input`, `Textarea` (с counter), `Checkbox`, `Switch`, `Select`.
- **Feedback**: `Snackbar` (toast), `Banner` (inline), `Modal`, `Spinner`, `Skeleton`.
- **Display**: `Badge` (status), `Avatar`, `Divider`, `Tag`.
- **Navigation**: `TabBar` (bottom), `BackButton` (native через WebApp API).

Custom components — только когда официальный kit не покрывает (e.g., `ScoreBadge`, `DraftVersionPicker`, `SourceHealthRow`).

## 4. Native Telegram chrome integration

Mini App **обязан** использовать native Telegram UI элементы вместо custom-кнопок там, где они есть:

- **BackButton** (`WebApp.BackButton`): показываем на всех screen'ах кроме root tabs. Скрываем при `unmount`.
- **MainButton** (`WebApp.MainButton`): main CTA каждого экрана (e.g., "Создать черновик", "Опубликовать"). Sticky-bottom от Telegram, не делаем свою.
- **SecondaryButton** (`WebApp.SecondaryButton`, доступна с TG 7.10+): destructive actions ("Отклонить", "Удалить").
- **HapticFeedback**: на success/error публикации + на confirm-modal.
- **closingConfirmation**: включаем когда в editor есть несохранённые изменения.
- **ThemeChange listener**: переключаем design tokens при изменении theme.

Это даёт ощущение "родной" Telegram-app, а не "веб-страницы внутри".

## 5. Performance budget

Цели MVP (измеряются на iPhone 12 / Pixel 6 в Chrome dev tools, throttling: Slow 4G):

| Метрика | Target | Hard limit |
|---|---|---|
| TTI (Time to Interactive) | < 1.5s | < 2.5s |
| FCP (First Contentful Paint) | < 0.8s | < 1.2s |
| LCP (Largest Contentful Paint) | < 1.2s | < 2.0s |
| Bundle size (gzip, initial) | < 150KB | < 200KB |
| Bundle size (gzip, total) | < 350KB | < 500KB |
| Lighthouse score (mobile) | ≥ 90 | ≥ 80 |

Techniques:
- **Code-splitting** по routes (`React.lazy` на Drafts editor, Sources, Settings — они тяжёлые);
- **Tree-shaking**: `@telegram-apps/telegram-ui` имеет ES-modules, импортируем только используемое;
- **Image optimization**: AVIF/WebP с fallback (Phase 8+, если введём image previews);
- **No moment.js**: используем `date-fns` или `dayjs` (~2KB);
- **No lodash**: native ES features или мини-utils;
- **Polyfills**: только для Safari 14- (Telegram iOS WebView).

CI gate: build size в bytes сравнивается с baseline. >10% рост — PR block.

## 6. Loading states (NO spinners-on-everything)

**Skeleton-first approach**: для всех list-views и detail-views используем skeleton screens, имитирующие финальный layout.

Spinner используется только:
- inline в кнопках на время mutation (e.g., "Публикую...");
- центральный full-screen — **только** на initial app boot (< 500ms typically).

Пример:
- Radar `GET /radar` загружается → 5 skeleton cards (правильные пропорции + shimmer);
- Draft editor `GET /drafts/:id` → skeleton header + textarea-placeholder.

Loading > 5s → показать "Кажется, медленно, проверь сеть" inline.

## 7. Error UX taxonomy

Не все ошибки одинаковы. Жёсткие правила:

| Тип | UI | Когда |
|---|---|---|
| **Toast (Snackbar)** | bottom-3s auto-dismiss | transient: copy success, mark-as-read, undo-able actions |
| **Inline banner** | sticky-top в section | state issue: "Канал отключён", "AI лимит исчерпан", "Бот без админ-прав" |
| **Field error** | red text below input | validation: "URL invalid", "слишком длинно" |
| **Modal** | full-screen с confirm/cancel | destructive: "Отклонить черновик?", "Опубликовать в канал?" |
| **Full-screen empty/error state** | center, illustration, actionable | empty list, fatal load error, no permission |

Нельзя:
- `alert()` нигде;
- 5 toast подряд (rate-limit: один toast одновременно);
- блок UI на 5s без feedback (всегда skeleton или spinner).

## 8. Accessibility baseline

Минимум для MVP:

- **Touch targets**: каждая интерактивная зона ≥ 44×44px (Apple HIG требование).
- **Contrast**: text-bg ≥ 4.5:1 (WCAG AA). Telegram theme tokens это обеспечивают; custom colors проверяем через Lighthouse.
- **Focus**: visible focus ring на keyboard nav (для Telegram Desktop user'ов).
- **Screen reader**: правильный semantic HTML (`<button>`, не `<div onClick>`); `aria-label` на icon-only кнопках.
- **Reduced motion**: respect `prefers-reduced-motion` — отключать animations.
- **Min font size**: 13px (Caption); основной body 15px (Telegram default).

CI gate: Lighthouse accessibility ≥ 90.

## 9. Onboarding wizard (первое открытие)

Если у user'а нет workspace/каналов/источников/тем — показываем wizard вместо пустого Радара.

3 шага:

```text
Шаг 1: Подключи канал
  [Подключить канал] -> screen "Канал"

Шаг 2: Добавь источники
  [Добавить источники] -> screen "Источники"

Шаг 3: Задай темы
  [Настроить темы] -> screen "Настройки"

[Пропустить — закрыть wizard и попасть в Радар]
```

Progress: точки сверху (1 of 3). Каждый шаг — single primary action.

После завершения — auto-redirect в Радар с placeholder "Ищем новости... первые появятся через 5–10 минут".

Wizard НЕ блокирует доступ — кнопка "Пропустить" всегда видна.

## 10. Routing

Routes (wouter):

```text
/                       -> Radar (default tab)
/radar                  -> Radar
/radar/:matchId         -> News detail
/drafts                 -> Drafts list
/drafts/:draftId        -> Draft editor
/sources                -> Sources list
/sources/new            -> Add source
/channel                -> Channel connection
/settings               -> Settings (topics, tone, notifications)
/onboarding             -> First-time wizard (auto-redirect if not done)
```

Deep-links через Telegram `startapp` param mapped to routes:

```text
?startapp=draft_<id>           -> /drafts/<id>
?startapp=connect_<code>       -> /channel?code=<code>
?startapp=radar_high_score     -> /radar?filter=score_7plus
?startapp=onboarding           -> /onboarding
```

Mini App initialization:
1. Read `WebApp.initDataUnsafe.start_param` (Telegram fills from URL).
2. Map к route и push.
3. Авто-redirect в onboarding если workspace без channel/sources/topics.

## 11. Animations rules

Minimal, purposeful:

- **CSS transitions** (default): `transform`, `opacity` 200ms ease для hover/press/show/hide.
- **framer-motion**:
  - Draft version swipe (3-variants);
  - Confirm-modal slide-up;
  - Skeleton shimmer.
- **No animations**:
  - Loading spinners (just appear);
  - Navigation transitions (handled by Telegram native chrome).

Respect `prefers-reduced-motion` — все animations 0ms.

## 12. Empty states checklist

Для **каждого** screen должен быть продуманный empty state. Не "Нет данных", а actionable:

| Screen | Empty state |
|---|---|
| Radar (no matches) | "Радар пока пуст. Подожди 5–10 мин, мы проверяем источники." + кнопка "Проверить сейчас" |
| Drafts (no drafts) | "Здесь будут готовые посты. Открой Радар, выбери новость, создай черновик." + кнопка "В Радар" |
| Sources (no sources) | "Добавь источники, чтобы радар начал работу." + кнопка "+ Добавить" |
| Channel (not connected) | (уже в `04-TELEGRAM-BOT-AND-MINIAPP-UX.md`) |
| Settings (no topics) | "Задай темы — без них радар не знает, что искать." + кнопка "Добавить темы" |
| Radar (filter empty) | "Под этот фильтр ничего не подходит. Попробуй сменить фильтр или подожди." |

Каждый empty state имеет иллюстрацию (mini-svg, ≤ 5KB). Использовать unique illustrations, не stock-радар.

## 13. Telegram-specific behaviors

- **Closing confirmation**: при unsaved changes в editor — `WebApp.enableClosingConfirmation()`.
- **Expand**: на старте `WebApp.expand()` для полного viewport.
- **Settings button** (`WebApp.SettingsButton`): открывает наш screen Settings (нативная кнопка в header).
- **Cloud Storage** (`WebApp.CloudStorage`): MVP не используем (всё на backend), но зарезервировано для preferences в Phase 8+.
- **Biometric Auth** (`WebApp.BiometricManager`): out of MVP.
- **Sharing** (`WebApp.shareToStory`, `WebApp.openLink`): для "поделиться черновиком с командой" — Phase MVP+1.

## 14. Image handling (text-only в MVP)

MVP — посты **только текстовые**.

Будущее (Phase MVP+1):
- AI-generated превью-картинки;
- attach image из source (если RSS отдаёт);
- user uploads image к посту.

Telegram канал поддерживает posts с image preview + caption (до 1024 chars в caption). Чтобы это добавить:
- editor — drag-drop / paste image;
- backend — store image (S3 или Telegram file_id cache);
- preview rendering — отдельный layout с image;
- adapter `publishPost` — `sendPhoto` вместо `sendMessage`.

Документируем как deferred, не строим в MVP.

## 15. QA checklist per screen

Перед merge'ом каждого screen-PR:

- [ ] dark theme проверен (через Telegram → Settings → Theme);
- [ ] light theme проверен;
- [ ] iOS Safari WebView (через `WebApp.platform === 'ios'`);
- [ ] Android WebView;
- [ ] Telegram Desktop;
- [ ] slow 4G throttling;
- [ ] offline state видим;
- [ ] keyboard поднимается без перекрытия CTA;
- [ ] back button native появляется и работает;
- [ ] empty state продуман;
- [ ] loading skeleton имеет правильные пропорции;
- [ ] errors показываются в правильном UI-tier (toast/banner/modal по таксономии);
- [ ] touch targets ≥ 44px;
- [ ] Lighthouse a11y ≥ 90;
- [ ] bundle delta < +10KB gzip.

## 16. Design review gates

В roadmap:

- **Phase 1**: stack setup, design tokens via Telegram theme, baseline components, onboarding wizard (можно stub с placeholder данными).
- **Phase 2–7**: каждая фаза с UI добавляет screens с обязательным empty/loading/error states; проходит §15 checklist.
- **Phase 8**: full QA pass на 3 platforms (iOS/Android/Desktop), Lighthouse audit, bundle-size baseline зафиксирован в CI.

После MVP — пользовательский usability test (5 user'ов, task-based) перед расширением tier'ов.
