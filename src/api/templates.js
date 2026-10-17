/**
 * Declarative template registry for the ActiveTab local API.
 * Mirrors the captured BrowserAct template shape; each template maps
 * validated inputs to a natural-language goal via goal_template.
 */
export const OFFICIAL_TEMPLATES = [
  {
    template_id: "local-web-reviews-scraper",
    name: "Local Web Reviews Scraper",
    bot_type: "agent",
    recommend_desc: "Scrape public review records from a web page using local browser navigation.",
    detail_url: "local://template/local-web-reviews-scraper",
    input_schema: {
      type: "object",
      required: ["url", "review_count"],
      properties: {
        url: { type: "string", minLength: 1, maxLength: 2000, description: "URL of the page containing reviews to scrape." },
        review_count: { type: "integer", minimum: 1, maximum: 100, default: 10, description: "Target number of review records to collect." }
      }
    },
    goal_template: "Go to {{url}} and extract {{review_count}} reviews"
  },
  {
    template_id: "local-page-data-extractor",
    name: "Local Page Data Extractor",
    bot_type: "agent",
    recommend_desc: "Navigate to a page and extract structured data using local browser automation.",
    detail_url: "local://template/local-page-data-extractor",
    input_schema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", minLength: 1, maxLength: 2000, description: "URL of the page to extract data from." },
        extraction_goal: { type: "string", maxLength: 500, default: "Extract all visible structured data", description: "What data to extract from the page." }
      }
    },
    goal_template: "Go to {{url}} and {{extraction_goal}}"
  },
  {
    template_id: "local-form-filler",
    name: "Local Form Filler",
    bot_type: "agent",
    recommend_desc: "Fill and submit a web form using local browser navigation.",
    detail_url: "local://template/local-form-filler",
    input_schema: {
      type: "object",
      required: ["url", "form_goal"],
      properties: {
        url: { type: "string", minLength: 1, maxLength: 2000, description: "URL of the page containing the form." },
        form_goal: { type: "string", minLength: 1, maxLength: 500, description: "Description of what to fill and submit." }
      }
    },
    goal_template: "Go to {{url}} and {{form_goal}}"
  }
];

export const REGIONS = [{ code: "LOCAL", name: "Local Machine" }];

export function findTemplate(id) {
  return OFFICIAL_TEMPLATES.find(t => t.template_id === id);
}

export function validateInput(schema, input) {
  const errors = [];
  if (schema.required) {
    for (const field of schema.required) if (!(field in input)) errors.push({ field, message: "must not be null" });
  }
  if (schema.properties) {
    for (const [field, spec] of Object.entries(schema.properties)) {
      if (!(field in input) || input[field] === null || input[field] === undefined) continue;
      const value = input[field];
      if (spec.type === "string") {
        if (typeof value !== "string") errors.push({ field, message: "must be a string" });
        else {
          if (spec.minLength && value.length < spec.minLength) errors.push({ field, message: `min length is ${spec.minLength}` });
          if (spec.maxLength && value.length > spec.maxLength) errors.push({ field, message: `max length is ${spec.maxLength}` });
        }
      }
      if (spec.type === "integer") {
        if (!Number.isInteger(value)) errors.push({ field, message: "must be an integer" });
        else {
          if (spec.minimum !== undefined && value < spec.minimum) errors.push({ field, message: `minimum is ${spec.minimum}` });
          if (spec.maximum !== undefined && value > spec.maximum) errors.push({ field, message: `maximum is ${spec.maximum}` });
        }
      }
      if (spec.type === "number" && typeof value !== "number") errors.push({ field, message: "must be a number" });
      if (spec.type === "boolean" && typeof value !== "boolean") errors.push({ field, message: "must be a boolean" });
      if (spec.type === "array" && !Array.isArray(value)) errors.push({ field, message: "must be an array" });
      if (spec.type === "object" && (typeof value !== "object" || Array.isArray(value))) errors.push({ field, message: "must be an object" });
    }
  }
  return errors;
}

export function renderGoal(template, input) {
  let goal = template.goal_template;
  for (const [key, value] of Object.entries(input)) {
    goal = goal.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
  }
  return goal;
}
