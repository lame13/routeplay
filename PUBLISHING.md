# Publish RoutePlay from a local machine

These commands bootstrap the public `github.com/lame13/routeplay` repository from a release archive or clean checkout.

## 1. Prepare and verify

```bash
unzip routeplay.zip # skip when already inside a source checkout
cd routeplay
npm ci
npx playwright install chromium
npm run check
npm pack --dry-run
```

Install and authenticate GitHub CLI if needed:

```bash
brew install gh
gh auth login
gh auth status
```

## 2. Create the Git history

```bash
git init -b main
git add -- \
  .dockerignore .editorconfig .env.example .github .gitignore \
  CHANGELOG.md CONTRIBUTING.md Dockerfile LICENSE PUBLISHING.md README.md SECURITY.md \
  biome.json examples package.json package-lock.json routeplay.schema.json \
  src test tsconfig.json tsup.config.ts vitest.config.ts
git commit -m "Initial RoutePlay release"
```

## 3. Create and push the public repository

```bash
gh repo create lame13/routeplay \
  --public \
  --source=. \
  --remote=origin \
  --push \
  --description "Regression-test SSR routes across server HTML, cold loads, and real client-side navigation." \
  --homepage "https://nikom.work"
```

## 4. Add discoverability topics

```bash
gh repo edit lame13/routeplay \
  --add-topic technical-seo \
  --add-topic ssr \
  --add-topic nextjs \
  --add-topic nuxt \
  --add-topic astro \
  --add-topic playwright \
  --add-topic typescript \
  --add-topic cli \
  --add-topic hydration \
  --add-topic client-side-navigation \
  --add-topic regression-testing \
  --add-topic seo-tools \
  --add-topic ci
```

Recommended repository description:

> Regression-test SSR routes across server HTML, cold loads, and real client-side navigation.

## 5. First release

After the repository CI passes:

```bash
git tag -a v0.1.0 -m "RoutePlay v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --generate-notes --title "RoutePlay v0.1.0"
```

The included npm release workflow requires an `NPM_TOKEN` repository secret. Do not enable npm publication until the package name, account, and release policy are confirmed.
