import { createServer } from "node:http";
import { once } from "node:events";

const definitions = [
  { id: "site-01-button", slug: "accounts", variant: "button" },
  { id: "site-02-link", slug: "reports", variant: "link" },
  { id: "site-03-aria", slug: "invoices", variant: "aria" },
  { id: "site-04-role-button", slug: "archive", variant: "role-button" },
  { id: "site-05-nested-name", slug: "settings", variant: "nested-name" },
  { id: "site-06-menuitem", slug: "support", variant: "menuitem" },
  { id: "site-07-input-button", slug: "orders", variant: "input-button" },
  { id: "site-08-nav-link", slug: "contacts", variant: "nav-link" },
  { id: "site-09-spa", slug: "notifications", variant: "spa" },
  { id: "site-10-history-link", slug: "activity", variant: "history-link" }
];

function fixtureDocument({ slug, variant }) {
  const path = `/${slug}`;
  const navigate = `location.assign('${path}')`;
  let control;
  switch (variant) {
    case "button":
      control = `<button id="goal" onclick="${navigate}">Open ${slug}</button>`;
      break;
    case "link":
      control = `<a id="goal" href="${path}">View ${slug}</a>`;
      break;
    case "aria":
      control = `<button id="goal" aria-label="Open ${slug}" onclick="${navigate}"><span aria-hidden="true">→</span></button>`;
      break;
    case "role-button":
      control = `<div id="goal" role="button" tabindex="0" onclick="${navigate}">Go to ${slug}</div>`;
      break;
    case "nested-name":
      control = `<button id="goal" onclick="${navigate}"><span>Open</span> <strong>${slug}</strong></button>`;
      break;
    case "menuitem":
      control = `<div id="goal" role="menuitem" tabindex="0" onclick="${navigate}">Visit ${slug}</div>`;
      break;
    case "input-button":
      control = `<input id="goal" type="button" value="Open ${slug}" onclick="${navigate}">`;
      break;
    case "nav-link":
      control = `<nav aria-label="Primary"><a id="goal" href="${path}">Open ${slug}</a></nav>`;
      break;
    case "spa":
      control = `<button id="goal" onclick="document.querySelector('h1').textContent='${slug}';document.title='${slug}'">Open ${slug}</button>`;
      break;
    case "history-link":
      control = `<a id="goal" href="${path}" onclick="event.preventDefault();history.pushState({},'', '${path}');document.querySelector('h1').textContent='${slug}';document.title='${slug}'">Open ${slug}</a>`;
      break;
    default:
      throw new Error(`Unknown benchmark site variant: ${variant}`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${slug} home</title></head><body><main><h1>Welcome</h1><button id="decoy" onclick="location.assign('/unrelated')">Open unrelated help</button>${control}</main></body></html>`;
}

export async function startBenchmarkSites() {
  const started = [];
  try {
    for (const definition of definitions) {
      const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        if (request.url?.split("?")[0] === `/${definition.slug}`) {
          const title = definition.slug[0].toUpperCase() + definition.slug.slice(1);
          response.end(`<!doctype html><title>${title}</title><main><h1>${title}</h1></main>`);
        } else if (request.url?.split("?")[0] === "/unrelated") {
          response.end("<!doctype html><title>Unrelated</title><main><h1>Unrelated</h1></main>");
        } else {
          response.end(fixtureDocument(definition));
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      started.push({
        ...definition,
        goal: `Open the ${definition.slug} page`,
        expectedPath: definition.variant === "spa" ? "/" : `/${definition.slug}`,
        url: `http://127.0.0.1:${server.address().port}/`,
        server
      });
    }
  } catch (error) {
    for (const item of started) {
      item.server.closeAllConnections();
      await new Promise(resolve => item.server.close(resolve));
    }
    throw error;
  }

  return {
    sites: started.map(({ server: _server, ...site }) => site),
    async close() {
      await Promise.all(started.map(async ({ server }) => {
        if (!server.listening) return;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }));
    }
  };
}
