# Framework notes

RoutePlay deliberately observes the browser boundary instead of private framework internals. Run it against a production build, not a development server.

## Next.js

Point `from` at a page containing a normal `next/link` destination. RoutePlay preserves prefetch behavior, opens `to` directly in a pristine context, then opens `from` in another pristine context and clicks the real anchor. Use `readySelector` when Suspense or a client data request changes the meaningful route content after the URL changes.

RoutePlay makes no assumptions about `.next` output or router globals. Add at least one App Router or Pages Router pair from the application itself; the repository test suite uses framework-neutral browser fixtures rather than claiming framework-internal coverage.

Next.js can return `200` with `noindex` when `notFound()` occurs after streaming has begun. RoutePlay records that status and meta-robots state but does not decide whether it is an acceptable soft-404 contract. Set `expectedStatus` to the deployed behavior and verify the negative-route policy separately.

## Nuxt

Use a normal internal `NuxtLink`. Universal SSR, prerendered routes, and hybrid route rules are all observable. A link configured as external may correctly produce `document` navigation; set `requireClientNavigation` only when soft navigation is part of your contract.

For data-heavy pages, add a stable selector that appears after the page is ready:

```vue
<main v-if="ready" data-routeplay-ready>
  <!-- route content -->
</main>
```

Then set `"readySelector": "[data-routeplay-ready]"`.

## Astro

Plain Astro pages are multi-page applications, so a normal link is expected to report `document`. Astro's cross-document View Transitions are still document navigations. Only projects using `ClientRouter` should normally set `requireClientNavigation` to `true`.

`astro:page-load` is useful for page scripts, but it does not prove every lazy island has hydrated. Add `data-routeplay-ready` to the meaningful route region when `client:idle`, `client:visible`, or remote data determines readiness.

RoutePlay's document identity plus document-request evidence distinguishes `ClientRouter` swaps from MPA/View Transition loads without reading Astro runtime globals.

## What to test

Choose route pairs that exercise changing metadata and content, not two near-identical pages:

- listing → detail;
- category → article;
- valid route → an explicit missing route;
- language A → language B;
- A → B and B → A when persistent layouts could retain stale head state.

RoutePlay only clicks a same-origin, same-tab `<a href>`. It never clicks buttons, submits forms, follows downloads, or invokes router APIs.
