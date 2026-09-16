import { createServer, type Server } from "node:http";

function shell(title: string, canonical: string, main: string, script = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="Fixture ${title}"><meta name="robots" content="index,follow"><link rel="canonical" href="${canonical}"></head><body><main>${main}</main>${script}</body></html>`;
}

const clientRouter = `<script>
document.addEventListener('click', (event) => {
  const anchor = event.target.closest('a[href]');
  if (!anchor) return;
  const url = new URL(anchor.href);
  if (!['/good/','/thin/','/stale/'].includes(url.pathname)) return;
  event.preventDefault(); history.pushState({}, '', url.pathname);
  const data = {
    '/good/': ['Good', '/good/', '<h1>Good</h1><p>This is complete stable content for the good route and it is present everywhere.</p><a href="/">Home</a>'],
    '/thin/': ['Thin', '/thin/', '<h1>Thin</h1><p>This meaningful route content appears in the hydrated browser but not in source HTML.</p><a href="/">Home</a>'],
    '/stale/': ['Stale', '/', '<h1>Stale</h1><p>The content changes but this synthetic client router intentionally leaves a stale canonical.</p><a href="/">Home</a>']
  }[url.pathname];
  document.title = data[0]; document.querySelector('link[rel=canonical]').href = data[1];
  document.querySelector('meta[name=description]').content = 'Fixture ' + data[0];
  document.querySelector('main').innerHTML = data[2];
});
</script>`;

export async function startFixtureServer(): Promise<{
  servers: Server[];
  baseUrl: string;
  crossOriginHits: () => number;
  crossOriginAuthorizations: () => Array<string | undefined>;
}> {
  let leakedRequests = 0;
  let retryOnceHits = 0;
  const crossOriginAuthorizations: Array<string | undefined> = [];
  const crossOriginServer = createServer((request, response) => {
    leakedRequests += 1;
    crossOriginAuthorizations.push(request.headers.authorization);
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(shell("Leaked", "/", "<h1>Leaked request</h1>"));
  });
  await new Promise<void>((resolve) => crossOriginServer.listen(0, "127.0.0.1", resolve));
  const crossOriginAddress = crossOriginServer.address();
  if (!crossOriginAddress || typeof crossOriginAddress === "string") {
    throw new Error("Cross-origin fixture did not expose a TCP port.");
  }
  const crossOriginUrl = `http://127.0.0.1:${crossOriginAddress.port}`;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.test").pathname;
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (pathname === "/") {
      response.end(
        shell(
          "Home",
          "/",
          '<h1>Home</h1><p>Choose a synthetic route for parity testing.</p><a href="/good/">Good</a><a href="/thin/">Thin</a><a href="/stale/">Stale</a><a href="/missing/">Missing</a><a href="/redirect-ok">Normalized redirect</a><a href="/redirect-wrong/">Wrong redirect</a><a href="/runtime/">Runtime failure</a><a href="/reflect/">Reflect</a><a href="/cross-origin/">Cross origin</a><a href="/retry-once/">Retry once</a><a href="/never-stable/">Never stable</a>',
          clientRouter,
        ),
      );
      return;
    }
    if (pathname === "/retry-once/") {
      retryOnceHits += 1;
      if (retryOnceHits === 1) {
        response.end(
          shell(
            "Retry",
            "/retry-once/",
            '<h1>Retry</h1><p>This document never stabilizes on its first request.</p><div id="churn"></div>',
            "<script>setInterval(() => { document.querySelector('#churn').textContent += 'x' }, 50)</script>",
          ),
        );
        return;
      }
      response.end(
        shell(
          "Retry",
          "/retry-once/",
          '<h1>Retry</h1><p>This route stabilizes on every later request so a retry can succeed.</p><a href="/">Home</a>',
        ),
      );
      return;
    }
    if (pathname === "/never-stable/") {
      response.end(
        shell(
          "Churn",
          "/never-stable/",
          '<h1>Churn</h1><p>This document intentionally never reaches semantic stability.</p><div id="churn"></div>',
          "<script>setInterval(() => { document.querySelector('#churn').textContent += 'x' }, 50)</script>",
        ),
      );
      return;
    }
    if (pathname === "/good/") {
      response.end(
        shell(
          "Good",
          "/good/",
          '<h1>Good</h1><p>This is complete stable content for the good route and it is present everywhere.</p><a href="/">Home</a>',
        ),
      );
      return;
    }
    if (pathname === "/custom-element/") {
      response.end(
        shell(
          "Custom element",
          "/custom-element/",
          '<h1>Custom element</h1><fixture-element>Stable content</fixture-element><a href="/custom-element/">Self</a>',
          `<script>
            let constructions = 0;
            customElements.define('fixture-element', class extends HTMLElement {
              constructor() { super(); document.title = 'Constructed ' + ++constructions; }
            });
          </script>`,
        ),
      );
      return;
    }
    if (pathname === "/connection-failure/") {
      request.socket.destroy();
      return;
    }
    if (pathname === "/thin/") {
      response.end(
        shell(
          "Loading",
          "/thin/",
          "<h1>Loading</h1><p>Please wait.</p>",
          `<script>document.title='Thin';document.querySelector('meta[name=description]').content='Fixture Thin';document.querySelector('main').innerHTML='<h1>Thin</h1><p>This meaningful route content appears in the hydrated browser but not in source HTML.</p><a href="/">Home</a>'</script>`,
        ),
      );
      return;
    }
    if (pathname === "/stale/") {
      response.end(
        shell(
          "Stale",
          "/stale/",
          '<h1>Stale</h1><p>The content changes but this synthetic client router intentionally leaves a stale canonical.</p><a href="/">Home</a>',
        ),
      );
      return;
    }
    if (pathname === "/js-source/") {
      response.end(
        shell(
          "JS source",
          "/js-source/",
          '<h1>JS source</h1><p>The destination anchor is deliberately absent from this response.</p><div id="links"></div>',
          `${clientRouter}<script>document.querySelector('#links').innerHTML='<a href="/good/">Injected good link</a>'</script>`,
        ),
      );
      return;
    }
    if (pathname === "/missing/") {
      response.statusCode = 404;
      response.end(
        shell(
          "Missing",
          "/missing/",
          '<h1>Missing</h1><p>This synthetic route is intentionally missing and returns the expected status.</p><a href="/">Home</a>',
        ),
      );
      return;
    }
    if (pathname === "/redirect-wrong/") {
      response.statusCode = 302;
      response.setHeader("location", "/login/");
      response.end();
      return;
    }
    if (pathname === "/redirect-ok") {
      response.statusCode = 308;
      response.setHeader("location", "/redirect-ok/");
      response.end();
      return;
    }
    if (pathname === "/redirect-ok/") {
      response.end(
        shell(
          "Normalized",
          "/redirect-ok/",
          '<h1>Normalized</h1><p>This route intentionally redirects to its configured final URL.</p><a href="/">Home</a>',
        ),
      );
      return;
    }
    if (pathname === "/login/") {
      response.end(
        shell(
          "Login",
          "/login/",
          '<h1>Login</h1><p>This is the wrong final destination for the configured route.</p><a href="/">Home</a>',
        ),
      );
      return;
    }
    if (pathname === "/reflect/") {
      const reflected = (request.headers.authorization ?? "none")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
      response.end(
        shell(
          "Reflect",
          "/reflect/",
          `<h1>Reflect</h1><p data-reflected="${reflected}">Credential reflection fixture: ${reflected}</p><a href="/">Home</a>`,
        ),
      );
      return;
    }
    if (pathname === "/runtime/") {
      response.end(
        shell(
          "Runtime",
          "/runtime/",
          '<h1>Runtime</h1><p>This fixture deliberately raises browser and request failures.</p><a href="/">Home</a>',
          "<script>setTimeout(() => { throw new Error('synthetic browser failure') }, 0); fetch('/api-fail/')</script>",
        ),
      );
      return;
    }
    if (pathname === "/api-fail/") {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end('{"error":"synthetic"}');
      return;
    }
    if (pathname === "/cross-origin/") {
      response.statusCode = 302;
      response.setHeader("location", `${crossOriginUrl}/leak/`);
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end(shell("Missing", pathname, "<h1>Missing</h1><p>This route does not exist.</p>"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server did not expose a TCP port.");
  return {
    servers: [server, crossOriginServer],
    baseUrl: `http://127.0.0.1:${address.port}`,
    crossOriginHits: () => leakedRequests,
    crossOriginAuthorizations: () => [...crossOriginAuthorizations],
  };
}
