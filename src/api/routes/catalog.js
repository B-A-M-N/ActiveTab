/** Route the authenticated compatibility API's bot and template catalog reads. */
const API_PREFIX = "/v3/bots";

export function createCatalogRoutes({ officialTemplates, regions, findTemplate, sendJson, sendError } = {}) {
  return async function handleCatalogRoute(_req, res, { method, path, query = {} } = {}) {
    if (method === "GET" && path === API_PREFIX) {
      const page = parseInt(query.page ?? "1", 10);
      const limit = parseInt(query.limit ?? "20", 10);
      const allItems = officialTemplates.map(template => ({
        bot_id: template.template_id,
        name: template.name,
        bot_type: template.bot_type,
        template_id: template.template_id,
        recommend_desc: template.recommend_desc
      }));
      sendJson(res, 200, {
        items: allItems.slice((page - 1) * limit, page * limit),
        page,
        limit,
        total_count: allItems.length,
        total_pages: Math.ceil(allItems.length / limit)
      });
      return true;
    }

    if (method === "GET" && path === `${API_PREFIX}/templates`) {
      const page = parseInt(query.page ?? "1", 10);
      const limit = parseInt(query.limit ?? "10", 10);
      const items = officialTemplates.map(template => ({
        name: template.name,
        template_id: template.template_id,
        bot_type: template.bot_type,
        recommend_desc: template.recommend_desc,
        detail_url: template.detail_url
      }));
      sendJson(res, 200, {
        items: items.slice((page - 1) * limit, page * limit),
        page,
        limit,
        total_count: items.length,
        total_pages: Math.ceil(items.length / limit)
      });
      return true;
    }

    if (method === "GET" && path.match(/^\/v3\/bots\/templates\/[^/]+$/)) {
      const template = findTemplate(path.split("/").pop());
      if (!template) { sendError(res, 400, 99010, "bot_id is invalid."); return true; }
      sendJson(res, 200, {
        name: template.name,
        template_id: template.template_id,
        bot_type: template.bot_type,
        description: template.recommend_desc,
        input_schema: template.input_schema,
        recommend_desc: template.recommend_desc,
        detail_url: template.detail_url,
        created_at: "2026-10-16T00:00:00Z",
        published_at: "2026-10-16T00:00:00Z"
      });
      return true;
    }

    if (method === "GET" && path === `${API_PREFIX}/regions`) {
      sendJson(res, 200, regions);
      return true;
    }

    if (method === "GET" && path.match(/^\/v3\/bots\/[^/]+$/)
      && !path.includes("templates") && !path.includes("runs") && !path.includes("regions")) {
      const template = findTemplate(path.split("/").pop());
      if (!template) { sendError(res, 400, 99010, "bot_id is invalid."); return true; }
      sendJson(res, 200, {
        bot_id: template.template_id,
        name: template.name,
        bot_type: template.bot_type,
        input_schema: template.input_schema,
        created_at: "2026-10-16T00:00:00Z"
      });
      return true;
    }

    return false;
  };
}
