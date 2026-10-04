# Release RoutePlay

RoutePlay is an npm CLI/library. Its release deployment is publishing the package; there is no application server to deploy. The project website is [nikocodes.com/software/routeplay](https://nikocodes.com/software/routeplay/).

## Verify the release

Use Node.js 22 or 24. From the release branch:

```bash
npm ci
npx playwright install chromium
npm run check
npm pack --dry-run
```

Keep `package.json`, the root versions in `package-lock.json`, `CHANGELOG.md`, and the release tag aligned. The CLI reads its version from package metadata.

## Configure npm Trusted Publishing

The existing `.github/workflows/release.yml` uses GitHub Actions OIDC. No `NPM_TOKEN` secret is required.

In the npm settings for the existing `routeplay` package, verify the GitHub Actions trusted publisher:

| Setting | Value |
|---|---|
| Organization or user | `lame13` |
| Repository | `routeplay` |
| Workflow filename | `release.yml` |
| Environment | Leave empty; the workflow does not use an environment |
| Allowed actions | Allow direct `npm publish` |

Trusted publishing requires npm 11.5.1+ and Node 22.14.0+. The workflow uses Node 24 on a GitHub-hosted Ubuntu runner and grants `id-token: write`. See [npm's Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Publish 0.5.0

The prepared local release branch is `release/v0.5.0`, with an annotated `v0.5.0` tag. Push the branch and open a PR:

```bash
git push -u origin release/v0.5.0
gh pr create --base main --head release/v0.5.0 \
  --title "Release RoutePlay 0.5.0" --fill
```

After CI and review, merge the PR using **Create a merge commit**, preserving the tagged release commit. Squash or rebase merging rewrites commits and requires reconciling the local tag before publishing it.

```bash
git fetch origin
git merge-base --is-ancestor 'v0.5.0^{commit}' origin/main
git push origin v0.5.0
gh release create v0.5.0 --verify-tag \
  --title "RoutePlay 0.5.0" --notes-from-tag
```

The annotated tag contains the 0.5.0 changelog as release notes. Stop if the ancestry check fails. Publishing the GitHub release triggers `release.yml`; pushing the branch or tag alone does not publish npm.

The workflow checks that the tag matches the package version, installs Chromium, runs lint/typecheck/tests/build, then runs `npm publish --access public`. A published npm version cannot be reused.

## Verify publication

```bash
gh run list --workflow release.yml --limit 5
gh run watch <run-id> --exit-status
npm view routeplay@0.5.0 version homepage --registry=https://registry.npmjs.org
npx --yes routeplay@0.5.0 --version
```

Users can then install with `npm install --save-dev routeplay@0.5.0` and install the matching browser with `npx routeplay install`.

## Optional Docker deployment

Build from the tagged checkout and run it against the target site as described in the README:

```bash
docker build -t routeplay:0.5.0 .
docker run --rm routeplay:0.5.0 --version
```

The release workflow publishes npm only; it does not push a Docker image or deploy the project website.
