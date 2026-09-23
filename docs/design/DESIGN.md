---
name: Props.trade
description: A matte trading workspace with a dark default and a warm paper alternative.
colors:
  paper: "#131217"
  paper-light: "#f6f5f1"
  surface: "#19181f"
  surface-light: "#fdfdfb"
  ink: "#f0edf5"
  ink-light: "#27232d"
  muted: "#b0a9b8"
  muted-light: "#6b6570"
  line: "#35313e"
  line-light: "#dedcd5"
  line-soft: "#29262f"
  line-soft-light: "#eeece6"
  purple: "#b28aff"
  purple-light: "#7946bc"
  purple-hover: "#c4a5ff"
  purple-hover-light: "#6735a5"
  purple-wash: "#2b213d"
  purple-wash-light: "#eee7f6"
  brand-purple: "#A470FD"
  on-primary: "#21142e"
  on-primary-light: "#ffffff"
  green: "#75c5a9"
  green-light: "#267963"
  green-wash: "#1b322b"
  green-wash-light: "#e9f2ed"
  red: "#e895a3"
  red-light: "#b14f59"
  red-wash: "#3b232b"
  red-wash-light: "#f7eaec"
  amber: "#d4b67b"
  amber-light: "#8c682d"
  amber-wash: "#352d20"
  amber-wash-light: "#f4eee0"
  buy: "#267a65"
  buy-hover: "#1b6957"
  sell: "#ab4f5b"
  white: "#ffffff"
  chart-label: "#afa6bc"
  chart-label-light: "#6e6975"
  badge-purple: "#c3a0f5"
  badge-purple-light: "#764ba8"
  account-strip: "#1c1922"
  account-strip-light: "#f0eee8"
typography:
  display:
    fontFamily: "Manrope, Arial, sans-serif"
    fontSize: "60px"
    fontWeight: 600
    lineHeight: 1.09
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Manrope, Arial, sans-serif"
    fontSize: "31px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Manrope, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Manrope, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.55
    fontFeature: "'ss01' on, 'tnum' on"
  label:
    fontFamily: "Manrope, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.55
  control:
    fontFamily: "Manrope, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.4
  metric:
    fontFamily: "Manrope, Arial, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  badge:
    fontFamily: "Manrope, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 650
    lineHeight: 1.5
rounded:
  segment: "3px"
  badge: "4px"
  field: "5px"
  control: "6px"
  surface: "7px"
  dialog: "10px"
spacing:
  "4": "4px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "24": "24px"
  "32": "32px"
components:
  button-primary:
    backgroundColor: "{colors.purple}"
    textColor: "{colors.on-primary}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "11px 16px"
  button-primary-hover:
    backgroundColor: "{colors.purple-hover}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "11px 16px"
  button-ghost:
    textColor: "{colors.purple}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "6px 9px"
  button-buy:
    backgroundColor: "{colors.buy}"
    textColor: "{colors.white}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "11px 16px"
  button-sell:
    backgroundColor: "{colors.sell}"
    textColor: "{colors.white}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "11px 16px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "11px 12px"
  navigation-active:
    textColor: "{colors.purple}"
  badge-purple:
    backgroundColor: "{colors.purple-wash}"
    textColor: "{colors.badge-purple}"
    typography: "{typography.badge}"
    rounded: "{rounded.badge}"
    padding: "3px 8px"
  surface:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.surface}"
  account-strip:
    backgroundColor: "{colors.account-strip}"
    padding: "15px 24px"
---

# Design System: Props.trade

## Overview

**Creative North Star: "The Quiet Trading Desk"**

Props.trade uses matte surfaces, fine rules and compact Manrope typography to keep figures and controls easy to scan. Dark is the default: charcoal with a slight violet cast, pale ink and a clear purple accent. Light mode retains the same structure on warm paper. Neither theme relies on texture, gloss or decorative depth.

The original three-part purple symbol is the fixed brand asset. Color and spacing give the rest of the interface a calm working character, while larger figures mark balances and outcomes. These descriptive names record the implemented system; they are documentation language derived from the brief and code, not additional choices attributed to the user.

**Key Characteristics:**

- Dark by default, with a persistent light appearance choice.
- Flat surfaces separated by tone and fine borders.
- One type family with stable tabular figures.
- Purple for selection and general actions; green, red and amber for meaning.
- Brief functional feedback and crisp vector marks.

This record follows the final implementation in `src/styles.css`, `src/themes.css`, `src/ui.jsx`, `src/Chart.jsx` and the shared application shell. The frontmatter describes the dark default; names ending in `-light` hold its light counterparts. Component entries use the default palette. Theme mappings, snippets, motion and elevation live in `.impeccable/design.json`.

## Colors

The palette pairs violet-tinted charcoal and warm paper with the same purple identity.

### Primary

- **Working purple** (`purple`): active navigation, selected controls, links, primary buttons and focus.
- **Purple wash** (`purple-wash`): selected backgrounds and quiet contextual emphasis.
- **Original brand purple** (`brand-purple`): the supplied symbol, unchanged in either theme. Use `public/brand/symbol.svg`; its authority remains the selected #31 master at `/Users/pp/Props.trade-selected-31/hq/Props.trade-symbol-master.svg`.
- **Primary foreground** (`on-primary`): dark ink on the bright dark-mode button; its light counterpart is white.

### Secondary

Green, red and amber are semantic colors. Gains and long positions use green; losses, short positions and errors use red; pending or caution states use amber. Pair color with signs, labels or status text. Each has a subdued wash. Buy and sell submit buttons retain their dedicated deeper fills and white text in both modes.

### Neutral

| Tokens | Purpose |
| --- | --- |
| `paper` / `paper-light` | Application ground, header and footer. |
| `surface` / `surface-light` | Working panels, fields and chart backgrounds. |
| `ink` / `ink-light` | Main text and figures. |
| `muted` / `muted-light` | Supporting text and labels. |
| `line` / `line-light` | Panel edges and structural dividers. |
| `line-soft` / `line-soft-light` | Interior rows and quieter separators. |
| `chart-label` / `chart-label-light` | Chart axes; these are distinct from general muted text. |

**The Semantic Color Rule.** Preserve the meaning of purple, green, red and amber across both themes; changing appearance must not change a control's meaning.

Chart candles, volume, guides and current-price tags have a dedicated palette in `Chart.jsx`. Keep readable axis and price-label colors separate from quieter candle fills. The source also contains a few local context colors; do not replace them indiscriminately with a weaker muted color.

## Typography

Use the bundled variable Manrope at `public/fonts/Manrope-Variable.ttf`, with Arial and sans-serif fallbacks. Manrope carries headings, body text, controls, addresses and numbers; there is no separate display or monospace family.

| Role | Application |
| --- | --- |
| Display | The acquisition headline; responsive overrides adjust it with its composition. |
| Headline | Ordinary page headings. |
| Title | Panel and section headings, with compact local sizes in the terminal. |
| Body | Default working text. |
| Label | Field labels and supporting hierarchy. |
| Control | Shared buttons. |
| Metric | Overview statistics; account balances and major outcomes use larger local sizes. |
| Badge | Concise stage and status labels. |

The scale is task-led, not a single mathematical ratio. Working labels commonly range from 10–12 pixels; dense chart and table annotations are smaller. Do not apply the smallest terminal annotations to general reading copy. Headings use gently tightened tracking, while numeric tables keep tabular figures and stable alignment.

**The Stable Figures Rule.** Preserve `tnum` and the table's tabular numerals so changing values do not disturb column rhythm.

## Layout

The application shares a compact header, content region and footer. Ordinary pages use a centered maximum width of 1370 pixels and base padding of 42px 38px 40px; narrower journey and detail layouts have their own bounds. Panels generally organize related material in two columns, then collapse for narrower screens. The full-width trading composition is recorded in its [surface brief](.impeccable/surfaces/src-trading-jsx.md).

Spacing repeats small increments, but the source is not a rigid universal grid. Use the frontmatter scale for common gaps and padding; preserve local dimensions where they express a specific working layout. Dense tables scroll within their own region.

Responsive changes occur at 1650, 1250, 1050, 800 and 600 pixels. At the widest size the terminal gains room for larger data and ticket padding. At 1050 pixels the supporting trade feed disappears. At 800 pixels the ticket becomes a focused overlay opened by a fixed Trade action. At 600 pixels the navigation becomes a compact menu, ordinary pages become single-column and open positions use action-bearing cards. Shared page padding reduces to 26px 17px 30px on phones.

## Elevation & Depth

Surfaces are flat at rest. Changes in tone and thin borders establish the hierarchy; ordinary cards do not cast shadows. The implementation contains no paper texture or glass treatment.

Shadows are reserved for temporary layers: dialogs, toast feedback, the phone navigation, the fixed Trade action and the mobile order overlay. The dark theme deepens the dialog, toast and order-overlay shadows. Exact values are in the sidecar.

**The Working Surface Rule.** Keep persistent charts, forms and tables flat; reserve lift for controls and content temporarily placed above them.

Motion is brief and functional: control colors transition over 160ms, toasts enter over 180ms with a small vertical movement, and loading spinners rotate. Both the system reduced-motion query and the application's Reduce motion setting remove animations and transitions.

## Shapes

Use modest corners: field and small-control shapes, slightly softer panels, and the largest radius on dialogs. Inner segments are tighter than their enclosing controls. Most boundaries are one-pixel rules. Circular forms belong to market marks, small state dots and specific progress or outcome indicators.

Preserve the original symbol's paths and proportions. Interface icons use Lucide or authored inline SVG; currency symbols remain valid text in amounts, while token and navigation icons use vector marks.

## Components

### Buttons

Shared buttons are compact, with a 40px minimum height, restrained corners and centered labels. Primary actions use working purple; secondary actions use a surface fill with a line border; ghost actions use purple text and a quiet hover wash. Buy and sell variants carry trading-side meaning. The small variant reduces the minimum height to 32px.

Hover changes color or border without shifting layout. A purple two-pixel focus outline sits outside controls. Disabled buttons use reduced opacity and a disabled cursor. Preserve the explicit action labels used by the interface.

### Chips

Badges are small status labels with a four-pixel radius and optional dot. Purple, green, red and amber variants use tinted backgrounds with readable text. They describe account stage, execution or eligibility; they are not decorative metadata.

### Cards / Containers

Working surfaces use a thin line border, surface fill and seven-pixel corners. Padding belongs to the content: common panel insets are around 22–24 pixels; the terminal is denser. Adjacent sections share interior rules. Hover treatment belongs to interactive cards or rows, not every container.

### Inputs / Fields

Labels sit above bordered fields with an eight-pixel gap. Standard inputs have a 41px minimum height and five-pixel corners. Unit-bearing fields keep the unit outside the editable value, inside a shared outline. Focus remains visible; invalid order input has text feedback near submission. Do not replace a label with placeholder text.

### Navigation

The four main sections use a quiet horizontal row, with purple text and a two-pixel underline for the active section. Tabs repeat that language at a smaller scale. The phone menu uses a surface panel and tinted active item. The visible sun/moon control and Appearance preference update the same saved theme choice; a new visitor starts in dark mode.

### Account context and charts

The account strip combines account identity, stage, equity and remaining loss allowance in a ruled band. Account and market switching preserve the surrounding workspace. The chart uses the active theme on its canvas and refits after width changes, while normal pan and zoom remain user-controlled. A paused-data overlay makes stale or unavailable prices visible.

Every figure comes from the Props.trade API, GMTrade or the chain; nothing synthetic renders. Practice and evaluation accounts are labelled Simulated; funded orders, purchases and payouts are wallet-signed transactions. Loading, empty, stale, unavailable, pending and failed states replace a value rather than invent one.

## Do's and Don'ts

### Do:

- **Do** use the default dark palette and the matching light palette as complete themes.
- **Do** preserve Manrope, tabular figures and the selected #31 symbol.
- **Do** use tone and fine rules to organize persistent working surfaces.
- **Do** pair semantic color with explicit text or signed values.
- **Do** preserve visible focus, reduced motion and the Simulated / Funded context.

### Don'ts:

- **Don't** recolor or redraw the approved brand symbol.
- **Don't** add grain, gloss, gradients or decorative shadows to the working panels.
- **Don't** carry a light-only hard-coded surface or label into dark mode.
- **Don't** use purple as a substitute for gain, loss or pending status.
- **Don't** show a figure the data does not provide; show its unavailable state instead.

